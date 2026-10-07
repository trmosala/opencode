import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { promptLength } from "@/components/prompt-input/history"
import { Cm3Icon } from "./cm3-icon"

export function Cm3Starters(props: { onSelect: () => void }) {
  const language = useLanguage()
  const prompt = usePrompt()
  const starters = [
    { icon: "magnifying-glass", title: "quietCompanion.trace", prompt: "quietCompanion.tracePrompt" },
    { icon: "code", title: "quietCompanion.build", prompt: "quietCompanion.buildPrompt" },
    { icon: "eye", title: "quietCompanion.review", prompt: "quietCompanion.reviewPrompt" },
  ] as const
  return (
    <ul class="cm3-starters" aria-label={language.t("quietCompanion.suggestions")}>
      <For each={starters}>
        {(starter) => (
          <li>
            <button
              type="button"
              onClick={() => {
                const start = promptLength(prompt.current())
                const content = `${start ? "\n\n" : ""}${language.t(starter.prompt)}`
                prompt.set(
                  [...prompt.current(), { type: "text", content, start, end: start + content.length }],
                  start + content.length,
                )
                props.onSelect()
              }}
            >
              <Cm3Icon name={starter.icon} />
              {language.t(starter.title)}
            </button>
          </li>
        )}
      </For>
    </ul>
  )
}
