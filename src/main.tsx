import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AudioPlayerProvider } from "./audio/AudioPlayerContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AudioPlayerProvider>
      <App />
    </AudioPlayerProvider>
  </StrictMode>,
);
