import { describe, expect, it, vi } from "vite-plus/test"
import { fetchRemoteUrl } from "../src/ssrf-protection.ts"

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]

describe("fetchRemoteUrl SSRF redirect protection", () => {
  it("blocks a redirect to the metadata service before making the second request", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    )

    await expect(
      fetchRemoteUrl(
        "https://public.example/start",
        {},
        {
          fetch: fetchMock,
          lookup: publicLookup,
        },
      ),
    ).rejects.toThrow(/blocked|internal/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://public.example/start"),
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it("fails closed for malformed allowRanges before issuing a request", async () => {
    const fetchMock = vi.fn<typeof fetch>()

    await expect(
      fetchRemoteUrl(
        "https://public.example/start",
        {},
        {
          fetch: fetchMock,
          lookup: publicLookup,
          allowRanges: ["198.18.0.0/"],
        },
      ),
    ).rejects.toThrow("Invalid CIDR notation in ssrf.allowRanges")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
