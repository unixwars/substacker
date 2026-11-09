import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./svg.js";

const enc = (s: string) => new TextEncoder().encode(s);
const run = (s: string) => {
  const out = sanitizeSvg(enc(s));
  return out ? new TextDecoder().decode(out) : null;
};
const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe("sanitizeSvg", () => {
  it("keeps a harmless drawing, namespaced", () => {
    const out = run(`<?xml version="1.0"?><svg ${NS} viewBox="0 0 10 10"><rect width="5" height="5" fill="red"/><g><circle cx="5" cy="5" r="2"/></g></svg>`);
    expect(out).toContain("<rect");
    expect(out).toContain("<circle");
    expect(out).toContain("viewBox");
    expect(out).toContain(`xmlns="http://www.w3.org/2000/svg"`);
  });
  it("keeps a fragment reference and a harmless style block", () => {
    const out = run(`<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="a" d="M0 0"/></defs><use xlink:href="#a"/><use href="#a"/><style>.a{fill:red}</style><rect class="a" fill="url(#g)"/></svg>`);
    expect(out).toContain('#a');
    expect(out).toContain(".a{fill:red}");
    expect(out).toContain("url(#g)");
  });
  const hostile: [string, string][] = [
    ["script", `<svg ${NS}><script>alert(1)</script><rect/></svg>`],
    ["onload", `<svg ${NS} onload="alert(1)"><rect onclick="alert(2)"/></svg>`],
    ["foreignObject", `<svg ${NS}><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script><img src=x onerror=alert(1)></div></foreignObject></svg>`],
    ["external use", `<svg ${NS}><use href="https://evil.test/x.svg#a"/><use xlink:href="//evil.test/x.svg#a"/></svg>`],
    ["javascript href", `<svg ${NS}><a href="javascript:alert(1)"><text>x</text></a><a xlink:href="javascript:alert(1)"><text>y</text></a></svg>`],
    ["entity", `<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg ${NS}>&x;<rect/></svg>`],
    ["stylesheet pi", `<?xml-stylesheet href="https://evil.test/a.css" type="text/css"?><svg ${NS}><rect/></svg>`],
    ["style url", `<svg ${NS}><style>rect{fill:url(https://evil.test/a)} @import url(https://evil.test/b.css);</style><rect style="fill:url(https://evil.test/c)" fill="url(https://evil.test/d)"/></svg>`],
    ["animate href", `<svg ${NS}><a href="#"><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>`],
    ["image external", `<svg ${NS}><image href="https://evil.test/p.png"/></svg>`],
    ["nested svg data", `<svg ${NS}><use href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"/></svg>`],
  ];
  it.each(hostile)("removes executable and external content: %s", (_n, svg) => {
    const out = run(svg);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/<script|<foreignObject|\son\w+=|javascript:|evil\.test|xml-stylesheet|<!DOCTYPE|<!ENTITY|@import|<animate|<set\b|<image|data:image\/svg/i);
    expect(out).not.toMatch(/alert\(/);
  });
  it("fails when nothing valid is left", () => {
    expect(run("<html><script>alert(1)</script></html>")).toBeNull();
    expect(run("")).toBeNull();
    expect(run("plain text")).toBeNull();
  });
});
