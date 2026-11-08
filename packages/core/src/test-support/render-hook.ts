import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal renderHook for tests: renders a component calling `hook` and exposes the latest result. */
export async function renderHook<T, P>(hook: (props: P) => T, initialProps: P) {
  const result: { current: T } = { current: undefined as T };
  function Probe({ props }: { props: P }) {
    result.current = hook(props);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe, { props: initialProps }));
  });
  return {
    result,
    async rerender(props: P) {
      await act(async () => {
        root.render(createElement(Probe, { props }));
      });
    },
    async settle() {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
    },
  };
}

type Routes = Record<string, unknown | (() => Response | Promise<Response>)>;

/** A fake fetch serving JSON by URL; unknown URLs are 404. Records the URLs asked for. */
export function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) return new Response("not found", { status: 404 });
    const value = routes[url];
    if (typeof value === "function") return (value as () => Response | Promise<Response>)();
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}
