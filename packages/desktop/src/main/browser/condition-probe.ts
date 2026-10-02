// Run only in the main-owned isolated world of the explicit document.
export function browserConditionScript(
  selector: string,
  condition: "visible" | "attached" | "ready",
  deadline: number,
) {
  return `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (${JSON.stringify(condition)} === "attached") return el.isConnected;
    if (${JSON.stringify(condition)} === "ready") return document.readyState !== "loading";
    let observer, timer;
    try {
      return await new Promise(resolve => {
        observer = new IntersectionObserver(entries => resolve(entries.some(entry => entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0 && entry.target.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))));
        timer = setTimeout(() => resolve(false), Math.min(100, Math.max(0, ${deadline} - Date.now())));
        observer.observe(el);
      });
    } finally { observer?.disconnect(); clearTimeout(timer); }
  })()`
}
