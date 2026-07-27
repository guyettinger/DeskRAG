import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
// Vidstack first: styles.css re-tints its layout through the --video-*/--media-*
// variables, so our rules have to land after the ones they override.
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
