import { describe, expect, it } from "vitest"
import { createWebUiApp } from "../src/server.ts"
import type { DashboardControlPlane } from "../src/types.ts"
import { FakeDashboardProject, FakeModelConfiguration } from "./fake-project.ts"
import { jsonOf, jsonRequest } from "./helpers.ts"

/** 内存版动态控制面：unconfigured → ready 两阶段。 */
function createControlPlane(projectName = "Demo CTF") {
  let project: FakeDashboardProject | undefined
  let phase: "unconfigured" | "ready" = "unconfigured"
  let archived = false
  let appliedConfig: unknown
  const deletedProjects: string[] = []
  const state = () => ({
    phase,
    configured: phase === "ready",
    projectId: phase === "ready" ? "demo" : null,
    projectName: phase === "ready" ? projectName : null,
    platformId: phase === "ready" ? "ctfd" : null,
    lastError: null,
    updatedAt: "2026-08-04T00:00:00.000Z",
    selectedProjectId: phase === "ready" ? "demo" : null,
    projects:
      phase === "ready"
        ? [
            {
              id: "demo",
              name: projectName,
              platformId: "ctfd",
              phase: "ready" as const,
              lastError: null,
              createdAt: "2026-08-04T00:00:00.000Z",
              updatedAt: "2026-08-04T00:00:00.000Z",
              archived,
            },
          ]
        : [],
  })
  const controlPlane: DashboardControlPlane = {
    snapshot: (projectId) => {
      if (projectId && projectId !== "demo") {
        // 不存在的项目：视为未配置状态
        return {
          ...state(),
          phase: "unconfigured",
          configured: false,
          projectId: null,
          projectName: null,
          selectedProjectId: null,
          projects: [],
        }
      }
      return state()
    },
    projectSnapshots: () => state().projects,
    selectProject: () => state(),
    setupSnapshot: () => ({
      state: state(),
      config: null,
      platforms: [
        {
          id: "ctfd",
          setup: {
            label: "CTFd",
            description: "test",
            defaultConfig: { tokenSecret: "CTFD_TOKEN" },
            fields: [],
            authStrategies: [],
          },
        },
      ],
      secrets: {},
    }),
    currentProject: (projectId) =>
      projectId === undefined || projectId === "demo" ? project : undefined,
    currentScheduler: () => undefined,
    testConnection: async () => ({
      ok: true,
      overview: {
        id: "demo",
        name: projectName,
        challenges: 3,
        announcements: 1,
      },
    }),
    applySetup: async ({ config }) => {
      appliedConfig = config
      project = new FakeDashboardProject()
      phase = "ready"
      return state()
    },
    connect: async () => state(),
    archiveProject: async (_projectId, nextArchived) => {
      archived = nextArchived
      return state()
    },
    deleteProject: async (projectId) => {
      deletedProjects.push(projectId)
      project = undefined
      phase = "unconfigured"
      return state()
    },
  }
  return { controlPlane, appliedConfig: () => appliedConfig, deletedProjects }
}

const DEMO_CONFIG = {
  version: 1,
  project: { id: "demo", name: "Demo CTF" },
  platform: {
    plugin: "ctfd",
    config: { baseUrl: "https://demo.ctfd.io", tokenSecret: "CTFD_TOKEN" },
  },
  sandbox: {
    image: "ctf-agent-solver:latest",
    privileged: false,
    networkMode: "bridge",
  },
}

function appWithControlPlane() {
  const plane = createControlPlane()
  let runtimeConfiguration = {
    solverModelId: "",
    tldrModelId: "",
    subagentModels: {},
    maxConcurrent: 8,
  }
  const app = createWebUiApp({
    controlPlane: plane.controlPlane,
    modelConfiguration: new FakeModelConfiguration(),
    projectRuntimeConfiguration: (projectId) =>
      projectId === "demo"
        ? {
            snapshot: () => structuredClone(runtimeConfiguration),
            update: async (configuration) => {
              runtimeConfiguration = structuredClone(configuration)
              return structuredClone(runtimeConfiguration)
            },
          }
        : undefined,
    onProjectDeleted: (projectId) => {
      plane.deletedProjects.push(`cache:${projectId}`)
    },
    frontendDist: "/nonexistent",
  })
  return { app: app.app, plane, runtime: () => runtimeConfiguration }
}

describe("动态控制面与项目管理", () => {
  it("未配置时提供空快照，challenge 不可用", async () => {
    const { app } = appWithControlPlane()
    const initial = await app.request("/api/snapshot")
    expect(await jsonOf(initial)).toMatchObject({
      overview: { name: "尚未配置比赛", challenges: 0 },
      controlPlane: { phase: "unconfigured" },
    })
    expect((await app.request("/api/challenges/pwn-1")).status).toBe(503)
  })

  it("测试连接、应用配置、查询与删除项目的完整流程", async () => {
    const { app, plane, runtime } = appWithControlPlane()

    const tested = await jsonRequest(app, "/api/projects/test", "POST", {
      config: DEMO_CONFIG,
      secrets: { CTFD_TOKEN: "secret" },
    })
    expect(tested.status).toBe(200)
    expect(await jsonOf(tested)).toMatchObject({ ok: true })

    const applied = await jsonRequest(app, "/api/projects", "POST", {
      config: DEMO_CONFIG,
      secrets: { CTFD_TOKEN: "secret" },
    })
    expect(applied.status).toBe(201)
    expect(plane.appliedConfig()).toEqual(DEMO_CONFIG)
    expect(await jsonOf(applied)).toMatchObject({
      project: { phase: "ready", projectId: "demo" },
      snapshot: { overview: { name: "Test CTF" } },
    })

    const listed = await app.request("/api/projects")
    expect(await jsonOf(listed)).toMatchObject({
      selectedProjectId: "demo",
      projects: [
        {
          id: "demo",
          name: "Demo CTF",
          phase: "ready",
          archived: false,
          solved: 1,
          total: 3,
        },
      ],
    })

    const archived = await jsonRequest(
      app,
      "/api/projects/demo/archive",
      "POST",
      { archived: true },
    )
    expect(archived.status).toBe(200)
    expect(await jsonOf(archived)).toMatchObject({
      controlPlane: { projects: [{ id: "demo", archived: true }] },
    })

    const scoped = await app.request("/api/projects/demo/snapshot")
    expect(await jsonOf(scoped)).toMatchObject({
      overview: { name: "Test CTF" },
    })

    const root = await app.request("/api/projects/demo")
    expect(root.status).toBe(200)
    expect(await jsonOf(root)).toMatchObject({ projectId: "demo" })

    // 不存在的项目：root 404，snapshot 为空快照
    expect((await app.request("/api/projects/nope")).status).toBe(404)
    expect(
      await jsonOf(await app.request("/api/projects/nope/snapshot")),
    ).toMatchObject({ overview: { name: "尚未配置比赛" } })

    const runtimeView = await app.request("/api/projects/demo/runtime-config")
    expect(await jsonOf(runtimeView)).toMatchObject({
      runtime: { maxConcurrent: 8 },
    })

    const runtimeUpdated = await jsonRequest(
      app,
      "/api/projects/demo/runtime-config",
      "POST",
      {
        solverModelId: "",
        tldrModelId: "",
        subagentModels: {},
        maxConcurrent: 3,
      },
    )
    expect(runtimeUpdated.status).toBe(200)
    expect(runtime().maxConcurrent).toBe(3)

    // 非法并发量被拒
    const invalid = await jsonRequest(
      app,
      "/api/projects/demo/runtime-config",
      "POST",
      {
        solverModelId: "",
        tldrModelId: "",
        subagentModels: {},
        maxConcurrent: 0,
      },
    )
    expect(invalid.status).toBe(400)
    expect(await jsonOf(invalid)).toMatchObject({
      error: "invalid_project_runtime_configuration",
    })

    const deleted = await jsonRequest(app, "/api/projects/demo", "DELETE", {})
    expect(deleted.status).toBe(200)
    expect(await jsonOf(deleted)).toMatchObject({
      controlPlane: { configured: false, projects: [] },
    })
    expect(plane.deletedProjects).toEqual(["demo", "cache:demo"])
    expect((await app.request("/api/projects/demo")).status).toBe(404)
  })

  it("无控制面时项目管理端点返回 404", async () => {
    const { app } = createWebUiApp({
      project: new FakeDashboardProject(),
      frontendDist: "/nonexistent",
    })
    for (const path of ["/api/projects", "/api/projects/test"]) {
      const response = await app.request(path, { method: "POST" })
      expect(response.status).toBe(404)
      expect(await jsonOf(response)).toMatchObject({
        error: "control_plane_unavailable",
      })
    }
    expect(await jsonOf(await app.request("/api/control-plane"))).toMatchObject(
      {
        error: "control_plane_unavailable",
      },
    )
  })

  it("控制面 apply/connect 失败时映射为 422/503", async () => {
    const plane = createControlPlane()
    const failing = plane.controlPlane
    failing.applySetup = async () => {
      throw new Error("平台拒绝连接")
    }
    failing.connect = async () => {
      throw new Error("平台超时")
    }
    const { app } = createWebUiApp({
      controlPlane: failing,
      frontendDist: "/nonexistent",
    })

    const applied = await jsonRequest(app, "/api/control-plane/apply", "POST", {
      config: DEMO_CONFIG,
    })
    expect(applied.status).toBe(422)
    expect(await jsonOf(applied)).toMatchObject({
      error: "platform_setup_failed",
    })

    const connected = await jsonRequest(
      app,
      "/api/control-plane/connect",
      "POST",
      {},
    )
    expect(connected.status).toBe(503)
    expect(await jsonOf(connected)).toMatchObject({
      error: "platform_connection_failed",
    })
  })

  it("连接配置校验：config 非对象或 secrets 含非字符串值时 400", async () => {
    const { app } = appWithControlPlane()
    for (const body of [
      { config: "not-an-object" },
      { config: DEMO_CONFIG, secrets: { TOKEN: 42 } },
    ]) {
      const response = await jsonRequest(
        app,
        "/api/projects/test",
        "POST",
        body,
      )
      expect(response.status).toBe(400)
    }
  })
})
