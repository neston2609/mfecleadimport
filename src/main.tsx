import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/prompt/400.css";
import "@fontsource/prompt/500.css";
import "@fontsource/prompt/600.css";
import "@fontsource/prompt/700.css";
import { Root } from "./AdminPortal";
import "./styles.css";
import "./app.css";
import "./leadsync.css";
import "./theme.css";
import { ThemeProvider } from "./Theme";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </React.StrictMode>,
);
