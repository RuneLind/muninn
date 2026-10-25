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
    function normalize(text2) {
      return text2.split(`
`).map((line) => line.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ")).join(`
`).replace(/\n{3,}/g, `

`).replace(/^[ \n]+|[ \n]+$/g, "");
    }
    function absoluteHttp(href) {
      if (!/^https?:\/\//i.test(href))
        return null;
      try {
        const url = new URL(href);
        return url.protocol === "http:" || url.protocol === "https:" ? href : null;
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
    function expandedFromText(text2) {
      const spelled = (text2 ?? "").replace(/\s+/g, "").replace(/(?:…|\.\.\.)+$/, "");
      if (!/^https?:\/\/\S+$/i.test(spelled))
        return null;
      const url = absoluteHttp(spelled);
      return url !== null && !isTco(url) ? url : null;
    }
    function encodeHref(url) {
      return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
    }
    function textIsUrl(text2, url) {
      const bare = (s) => s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
      const shown = bare(text2.replace(/(?:…|\.\.\.)+$/, ""));
      if (shown === "")
        return true;
      return /^[^\s]+$/.test(shown) && bare(url).toLowerCase().startsWith(shown.toLowerCase());
    }
    function wrap(inner, open, close) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
      return m[2] === "" ? inner : `${m[1]}${open}${m[2]}${close}${m[3]}`;
    }
    function anchor(node, ctx) {
      const text2 = walkChildren(node, ctx);
      let target = absoluteHttp((attr(node, "href") ?? "").trim());
      if (target !== null && isTco(target))
        target = expandedFromText(node.textContent) ?? target;
      if (target === null)
        return text2;
      const href = encodeHref(target);
      const label = text2.replace(/\s+/g, " ").trim().replace(/\[/g, "(").replace(/\]/g, ")");
      const lead = /^\s/.test(text2) ? " " : "";
      const tail = /\s$/.test(text2) ? " " : "";
      if (label === "" || textIsUrl(label, target))
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
        const text2 = cells.map((c) => normalize(walkChildren(c, ctx)).replace(/\n+/g, " ").replace(/\|/g, "\\|"));
        out.push(`| ${text2.join(" | ")} |`);
        if (i === 0)
          out.push(`| ${cells.map(() => "---").join(" | ")} |`);
      });
      return `

${out.join(`
`)}

`;
    }
    function walkChildren(node, ctx) {
      let out = "";
      for (const child of children(node))
        out += walk(child, ctx);
      return out;
    }
    function walk(node, ctx) {
      if (node.nodeType === TEXT) {
        const text2 = node.textContent ?? "";
        return ctx.pre ? text2 : text2.replace(/[\s ]+/g, " ");
      }
      if (node.nodeType !== ELEMENT && node.nodeType !== 9 && node.nodeType !== 11)
        return "";
      if (node.nodeType !== ELEMENT)
        return walkChildren(node, ctx);
      const tag = tagOf(node);
      if (SKIP.has(tag) || hidden(node))
        return "";
      if (ctx.pre)
        return tag === "br" ? `
` : walkChildren(node, ctx);
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
          const text2 = normalize(walkChildren(node, ctx)).replace(/\n+/g, " ");
          return text2 === "" ? "" : `

${"#".repeat(Number(tag[1]))} ${text2}

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
          const code = walkChildren(node, { pre: true }).replace(/^\n+|\n+$/g, "");
          if (code.trim() === "")
            return "";
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
          const code = (node.textContent ?? "").replace(/\s+/g, " ");
          if (code.trim() === "")
            return code;
          const tick = code.includes("`") ? "``" : "`";
          return `${tick}${code}${tick}`;
        }
        case "strong":
        case "b":
          return wrap(walkChildren(node, ctx), "**", "**");
        case "em":
        case "i":
          return wrap(walkChildren(node, ctx), "*", "*");
        case "a":
          return anchor(node, ctx);
        default:
          return BLOCK.has(tag) ? `

${walkChildren(node, ctx)}

` : walkChildren(node, ctx);
      }
    }
    const text = normalize(walk(root, { pre: false }));
    return text.replace(/\t\t(\d+)\t\t|\t/g, (_m, i) => i === undefined ? " " : codeBlocks[Number(i)] ?? "");
  }

  // src/summaries/html-to-markdown.extension.ts
  globalThis.muninnHtmlToMarkdown = htmlToMarkdown;
})();
