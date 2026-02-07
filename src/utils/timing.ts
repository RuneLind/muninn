interface Mark {
  label: string;
  startMs: number;
  endMs?: number;
}

export interface TimingExtras {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  startupMs?: number;
  apiMs?: number;
}

export class Timing {
  private marks: Mark[] = [];
  private totalStart = performance.now();

  start(label: string): void {
    this.marks.push({ label, startMs: performance.now() });
  }

  end(label: string): number {
    const mark = this.marks.find((m) => m.label === label && !m.endMs);
    if (!mark) throw new Error(`No active mark for "${label}"`);
    mark.endMs = performance.now();
    return mark.endMs - mark.startMs;
  }

  totalMs(): number {
    return performance.now() - this.totalStart;
  }

  summary(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const m of this.marks) {
      result[m.label] = m.endMs ? m.endMs - m.startMs : performance.now() - m.startMs;
    }
    return result;
  }

  formatTelegram(extras?: TimingExtras): string {
    const total = this.totalMs();
    const s = this.summary();

    const parts: string[] = [`${fmtDuration(total)} total`];

    // Show startup (MCP init) separately from API time
    if (extras?.startupMs && extras.startupMs > 500) {
      parts.push(`mcp ${fmtDuration(extras.startupMs)}`);
    }
    if (extras?.apiMs) {
      parts.push(`api ${fmtDuration(extras.apiMs)}`);
    } else if (s.claude) {
      parts.push(`claude ${fmtDuration(s.claude)}`);
    }

    if (s.prompt_build && (s.prompt_build) > 100) parts.push(`prompt ${fmtDuration(s.prompt_build)}`);
    if (s.stt) parts.push(`stt ${fmtDuration(s.stt)}`);
    if (s.tts) parts.push(`tts ${fmtDuration(s.tts)}`);

    if (extras?.inputTokens || extras?.outputTokens) {
      parts.push(`${fmtTokens(extras.inputTokens ?? 0)} in, ${fmtTokens(extras.outputTokens ?? 0)} out`);
    }

    if (extras?.costUsd) {
      parts.push(`$${extras.costUsd.toFixed(4)}`);
    }

    return parts.join(" | ");
  }
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
