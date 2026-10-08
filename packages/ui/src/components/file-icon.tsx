import type { Component, JSX } from "solid-js"
import { splitProps } from "solid-js"
import { paths } from "./phosphor"

export type FileIconProps = JSX.GSVGAttributes<SVGSVGElement> & {
  node: { path: string; type: "file" | "directory" }
  expanded?: boolean
  mono?: boolean
}

export const FileIcon: Component<FileIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["node", "class", "classList", "expanded", "mono"])
  return (
    <svg
      {...rest}
      data-component="file-icon"
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden={rest["aria-hidden"] ?? "true"}
      classList={{ ...local.classList, [local.class ?? ""]: !!local.class }}
    >
      <path d={paths[chooseIconName(local.node.path, local.node.type, local.expanded ?? false)]} />
    </svg>
  )
}

export function chooseIconName(path: string, type: "directory" | "file", expanded: boolean) {
  if (type === "directory") return expanded ? "folder-open" : "folder"
  const extension = path.split(/[\\/]/).pop()?.toLowerCase().split(".").pop() ?? ""
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(extension)) return "file-image"
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(extension)) return "file-audio"
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(extension)) return "file-video"
  if (["zip", "gz", "tar", "7z", "rar"].includes(extension)) return "file-zip"
  if (extension === "pdf") return "file-pdf"
  if (["csv", "tsv"].includes(extension)) return "file-csv"
  if (["doc", "docx"].includes(extension)) return "file-doc"
  if (["txt", "md", "mdx", "log", "rst"].includes(extension)) return "file-text"
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "file-js"
  if (["ts", "tsx", "mts", "cts"].includes(extension)) return "file-ts"
  if (["html", "htm"].includes(extension)) return "file-html"
  if (["css", "scss", "sass", "less"].includes(extension)) return "file-css"
  if (
    [
      "py",
      "go",
      "rs",
      "rb",
      "java",
      "kt",
      "swift",
      "c",
      "cpp",
      "h",
      "sh",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
      "sql",
      "vue",
      "svelte",
    ].includes(extension)
  )
    return "file-code"
  return "file"
}
