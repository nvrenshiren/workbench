import { ConfigProvider, theme } from "antd"
import zhCN from "antd/locale/zh_CN"
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { ACCENT, SURFACE } from "./ui"
import "./styles.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: ACCENT,
          colorInfo: ACCENT,
          colorBgBase: SURFACE.canvas,
          colorBgContainer: SURFACE.panel,
          colorBgElevated: SURFACE.raised,
          colorBgLayout: SURFACE.canvas,
          colorBorder: SURFACE.lineStrong,
          colorBorderSecondary: SURFACE.line,
          borderRadius: 8,
          fontSize: 15,
          controlHeight: 36,
          sizeUnit: 5,
          sizeStep: 5,
          fontFamily:
            '-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif'
        },
        components: {
          Tree: { indentSize: 20 },
          Tabs: { horizontalMargin: "0 0 12px 0" },
          Drawer: { paddingLG: 20 }
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
