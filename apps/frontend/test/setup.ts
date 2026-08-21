import { vi } from "vite-plus/test"

// Iconify 会在后台定时加载图标并触发 React state update。
// 测试只验证页面行为，不依赖图标内容；全局桩避免 jsdom 销毁后访问 window。
vi.mock("@iconify/react", () => ({ Icon: () => null }))
