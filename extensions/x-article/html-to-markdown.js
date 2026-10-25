(() => {
  // src/summaries/html-to-markdown.ts
  function htmlToMarkdown(root, options = {}) {
    const ELEMENT = 1;
    const TEXT = 3;
    const INDENT = "\t";
    const slot = (i) => `		${i}		`;
    const SKIP = new Set([
      "script",
      "style",
      "noscript",
      "template",
      "svg",
      "head",
      "title",
      "meta",
      "link",
      "button",
      "iframe",
      "img",
      "picture",
      "video",
      "audio",
      "canvas",
      "input",
      "select",
      "textarea",
      "nav"
    ]);
    const BLOCK = new Set([
      "p",
      "section",
      "article",
      "main",
      "header",
      "footer",
      "aside",
      "figure",
      "figcaption",
      "address",
      "details",
      "summary",
      "dl",
      "dt",
      "dd",
      "form",
      "fieldset"
    ]);
    const PRE_BREAK = new Set([
      ...BLOCK,
      "div",
      "li",
      "tr",
      "ul",
      "ol",
      "menu",
      "table",
      "blockquote",
      "pre",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6"
    ]);
    const codeBlocks = [];
    const isHidden = options.isHidden;
    const tagOf = (node) => node.nodeName.toLowerCase();
    const attr = (node, name) => typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
    const children = (node) => Array.from(node.childNodes);
    function hidden(node) {
      if (attr(node, "hidden") !== null)
        return true;
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(node, "style") ?? ""))
        return true;
      return isHidden ? isHidden(node) : false;
    }
    function normalize(text) {
      return text.split(`
`).map((line) => line.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ")).join(`
`).replace(/\n{3,}/g, `

`).replace(/^[ \n]+|[ \n]+$/g, "");
    }
    function absoluteHttp(href) {
      if (!/^https?:\/\//i.test(href))
        return null;
      try {
        const url = new URL(href);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
      } catch {
        return null;
      }
    }
    function isTco(url) {
      try {
        return new URL(url).hostname.toLowerCase() === "t.co";
      } catch {
        return false;
      }
    }
    function expandedFromText(text) {
      const spelled = (text ?? "").replace(/\s+/g, "").replace(/(?:…|\.\.\.)+$/, "");
      if (!/^https?:\/\/\S+$/i.test(spelled))
        return null;
      const url = absoluteHttp(spelled);
      return url !== null && !isTco(url) ? url : null;
    }
    function encodeHref(url) {
      return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
    }
    function textIsUrl(text, url) {
      const shown = text.replace(/(?:…|\.\.\.)+$/, "");
      if (!/^\S+$/.test(shown))
        return false;
      if (/^(?:https?:\/\/)?[^/?#]*@/i.test(shown))
        return false;
      let parsed;
      let target;
      try {
        parsed = new URL(/^https?:\/\//i.test(shown) ? shown : `https://${shown}`);
        target = new URL(url);
      } catch {
        return false;
      }
      const host = (u) => u.hostname.toLowerCase().replace(/^www\./, "");
      if (host(parsed) !== host(target))
        return false;
      const rest = (u) => `${u.pathname}${u.search}${u.hash}`.replace(/\/+$/, "");
      return rest(target).startsWith(rest(parsed));
    }
    function wrap(inner, open, close) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      return m[2] === "" || /\n/.test(m[2]) || /\n\n/.test(inner) ? inner : `${m[1]}${open}${m[2]}${close}${m[3]}`;
    }
    function inlineCode(code) {
      const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
      const tick = "`".repeat(longest + 1);
      const pad = /^`|`$/.test(code) ? " " : "";
      return `${tick}${pad}${code}${pad}${tick}`;
    }
    function hasLink(node) {
      return children(node).some((c) => c.nodeType === ELEMENT && (tagOf(c) === "a" && absoluteHttp((attr(c, "href") ?? "").trim()) !== null || hasLink(c)));
    }
    function anchor(node, ctx) {
      let target = absoluteHttp((attr(node, "href") ?? "").trim());
      const text = walkChildren(node, { ...ctx, inline: true, label: target !== null });
      if (target !== null && isTco(target))
        target = expandedFromText(node.textContent) ?? target;
      if (target === null)
        return text;
      const href = encodeHref(target);
      const label = text.replace(/\s+/g, " ").trim().replace(/\[/g, "(").replace(/\]/g, ")");
      const lead = /^\s/.test(text) ? " " : "";
      const tail = /\s$/.test(text) ? " " : "";
      if (label === "")
        return text;
      if (textIsUrl(label, target))
        return `${lead}${href}${tail}`;
      return `${lead}[${label}](${href})${tail}`;
    }
    function list(node, ctx, ordered) {
      const items = children(node).filter((c) => c.nodeType === ELEMENT && tagOf(c) === "li" && !hidden(c));
      const start = Number.parseInt(attr(node, "start") ?? "1", 10);
      const lines = items.map((li, i) => {
        const marker = ordered ? `${(Number.isFinite(start) ? start : 1) + i}. ` : "- ";
        const body = normalize(walkChildren(li, ctx)).replace(/\n{2,}/g, `
`).split(`
`);
        const pad = INDENT.repeat(marker.length);
        return marker + body.map((l, j) => j === 0 || l === "" ? l : pad + l).join(`
`);
      });
      return `

${lines.join(`
`)}

`;
    }
    function table(node, ctx) {
      const rows = [];
      const collect = (n) => {
        for (const c of children(n)) {
          if (c.nodeType !== ELEMENT || hidden(c))
            continue;
          const tag = tagOf(c);
          if (tag === "tr")
            rows.push(c);
          else if (tag === "thead" || tag === "tbody" || tag === "tfoot")
            collect(c);
        }
      };
      collect(node);
      if (rows.length === 0)
        return "";
      const out = [];
      rows.forEach((row, i) => {
        const cells = children(row).filter((c) => c.nodeType === ELEMENT && (tagOf(c) === "td" || tagOf(c) === "th"));
        const text = cells.map((c) => normalize(walkChildren(c, { ...ctx, inline: true })).replace(/\n+/g, " ").replace(/\|/g, "\\|"));
        out.push(`| ${text.join(" | ")} |`);
        if (i === 0)
          out.push(`| ${cells.map(() => "---").join(" | ")} |`);
      });
      return `

${out.join(`
`)}

`;
    }
    function preText(node) {
      let out = "";
      for (const c of children(node)) {
        if (c.nodeType === TEXT)
          out += c.textContent ?? "";
        if (c.nodeType !== ELEMENT || SKIP.has(tagOf(c)) || hidden(c))
          continue;
        if (tagOf(c) === "br") {
          out += `
`;
          continue;
        }
        const inner = preText(c);
        if (!PRE_BREAK.has(tagOf(c))) {
          out += inner;
          continue;
        }
        if (out !== "" && !out.endsWith(`
`))
          out += `
`;
        out += inner;
        if (inner !== "" && !inner.endsWith(`
`))
          out += `
`;
      }
      return out;
    }
    function walkChildren(node, ctx) {
      let out = "";
      for (const child of children(node))
        out += walk(child, ctx);
      return out;
    }
    function walk(node, ctx) {
      if (node.nodeType === TEXT) {
        const text = (node.textContent ?? "").replace(/[\s ]+/g, " ");
        return ctx.label ? text.replace(/\\/g, "\\\\") : text;
      }
      if (node.nodeType !== ELEMENT && node.nodeType !== 9 && node.nodeType !== 11)
        return "";
      if (node.nodeType !== ELEMENT)
        return walkChildren(node, ctx);
      const tag = tagOf(node);
      if (SKIP.has(tag) || hidden(node))
        return "";
      switch (tag) {
        case "br":
          return `
`;
        case "hr":
          return `

---

`;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          const text = normalize(walkChildren(node, { ...ctx, inline: true })).replace(/\n+/g, " ");
          return text === "" ? "" : `

${"#".repeat(Number(tag[1]))} ${text}

`;
        }
        case "div":
        case "li":
        case "tr":
          return `
${walkChildren(node, ctx)}
`;
        case "blockquote": {
          const inner = normalize(walkChildren(node, ctx));
          return inner === "" ? "" : `

${inner.split(`
`).map((l) => l === "" ? ">" : `> ${l}`).join(`
`)}

`;
        }
        case "ul":
        case "menu":
          return list(node, ctx, false);
        case "ol":
          return list(node, ctx, true);
        case "table":
          return table(node, ctx);
        case "pre": {
          const code = preText(node).replace(/^\n+|\n+$/g, "");
          if (code.trim() === "")
            return "";
          if (ctx.inline)
            return inlineCode(code.replace(/\s+/g, " ").trim());
          const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((r) => r.length));
          const fence = "`".repeat(longest + 1);
          codeBlocks.push(`${fence}
${code}
${fence}`);
          return `

${slot(codeBlocks.length - 1)}

`;
        }
        case "code":
        case "kbd":
        case "samp": {
          if (hasLink(node))
            return walkChildren(node, ctx);
          const code = (node.textContent ?? "").replace(/\s+/g, " ");
          if (code.trim() === "")
            return code;
          return inlineCode(code);
        }
        case "strong":
        case "b":
          return /font-weight\s*:\s*(?:normal|[1-4]00)\b/i.test(attr(node, "style") ?? "") ? walkChildren(node, ctx) : wrap(walkChildren(node, ctx), "**", "**");
        case "em":
        case "i":
          return /font-style\s*:\s*normal\b/i.test(attr(node, "style") ?? "") ? walkChildren(node, ctx) : wrap(walkChildren(node, ctx), "*", "*");
        case "a":
          return anchor(node, ctx);
        default:
          return BLOCK.has(tag) ? `

${walkChildren(node, ctx)}

` : walkChildren(node, ctx);
      }
    }
    return normalize(walk(root, { inline: false })).split(`
`).map((line) => {
      const m = /\t\t(\d+)\t\t/.exec(line);
      if (m === null)
        return line.replace(/\t/g, " ");
      const prefix = line.slice(0, m.index);
      const first = prefix.replace(/\t/g, " ");
      const rest = prefix.replace(/[^>]/g, " ");
      const block = (codeBlocks[Number(m[1])] ?? "").split(`
`).map((l, j) => j === 0 ? first + l : l === "" ? rest.trimEnd() : rest + l).join(`
`);
      return block + line.slice(m.index + m[0].length).replace(/\t/g, " ");
    }).join(`
`);
  }

  // src/summaries/html-to-markdown.extension.ts
  globalThis.muninnHtmlToMarkdown = htmlToMarkdown;
})();
