import { ipcRenderer } from "electron"

// Only wheel events need a renderer bridge; mouse and keyboard input stay in the main process.
window.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault()
    ipcRenderer.send(
      "worker-preview-wheel",
      Math.round(event.clientX),
      Math.round(event.clientY),
      -event.deltaX,
      -event.deltaY,
    )
  },
  { passive: false },
)
