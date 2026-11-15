/** The footer's usage figures: what is left of the plan (subscription only) and what this session used. */
import { useEffect, useReducer } from "preact/hooks";
import { onUsage, startUsage, usageNow, view } from "./usage";

export function Usage() {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const off = onUsage(() => tick(0));
    const stop = startUsage();
    return () => {
      off();
      stop();
    };
  }, []);

  const v = view(usageNow());
  if (!v) return null;
  return (
    <span class="usage">
      {v.plan && (
        <span class={`usage-plan${v.plan.attn ? " attn" : ""}${v.plan.limited ? " limited" : ""}`} title={v.plan.title}>
          {v.plan.text}
        </span>
      )}
      {v.session && (
        <span class="usage-session" title={v.session.title} data-calls={v.session.calls}>
          {v.session.text}
        </span>
      )}
    </span>
  );
}
