import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { Loading, LoadingAnimationProvider } from "@opencode-ai/ui/loading"
import { Spinner } from "@opencode-ai/ui/spinner"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SessionProgressIndicatorV2 } from "@opencode-ai/session-ui/v2/session-progress-indicator-v2"
import { cmLoading } from "../src/components/cm-loading"
import "../../ui/src/components/spinner.css"

function Fixture() {
  const [state, setState] = createStore({ colour: "rgb(17, 91, 177)", label: "Waiting", background: "white" })
  return (
    <main
      style={{
        "--icon-base": state.colour,
        "--v2-icon-icon-muted": state.colour,
        color: "var(--icon-base)",
        background: state.background,
        padding: "24px",
      }}
    >
      <button id="theme" onClick={() => setState({ colour: "rgb(215, 225, 235)", background: "rgb(22, 24, 28)" })}>
        Theme
      </button>
      <button id="update" onClick={() => setState("label", "Still waiting")}>
        Update
      </button>
      <section id="stock">
        <Spinner />
      </section>
      <LoadingAnimationProvider value={cmLoading}>
        <section id="random" style={{ display: "flex", gap: "4px" }}>
          <For each={Array.from({ length: 24 }, (_, i) => i)}>
            {() => <Loading width={32} height={32} aria-label={state.label} aria-hidden="false" />}
          </For>
        </section>
        <section id="adapters" style={{ display: "flex", gap: "16px", padding: "16px" }}>
          <Spinner style={{ width: "32px", height: "32px" }} />
          <LoaderV2 width={32} height={32} />
          <Icon name="spinner" style={{ width: "32px", height: "32px" }} />
          <SessionProgressIndicatorV2 width={32} height={32} />
        </section>
      </LoadingAnimationProvider>
      <section id="variants" style={{ display: "grid", "grid-template-columns": "repeat(4, 160px)", gap: "16px" }}>
        <For each={cmLoading.animations}>
          {(animation) => (
            <div data-case={animation.id}>
              <LoadingAnimationProvider value={{ animations: [animation], still: cmLoading.still }}>
                <Loading width={128} height={128} />
              </LoadingAnimationProvider>
              <div>{animation.id}</div>
            </div>
          )}
        </For>
      </section>
    </main>
  )
}

render(() => <Fixture />, document.getElementById("root")!)
