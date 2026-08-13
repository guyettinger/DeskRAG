import React, { useEffect, useState } from "react";
import type { McpLogEntryDTO, McpSettings, McpStatusDTO } from "@shared/types";
import { api } from "../api.js";

interface Props {
  mcp: McpSettings;
  onPatch: (patch: Partial<McpSettings>) => Promise<void>;
}

/** How many calls the pane shows. The server keeps 200; this is what fits. */
const SHOWN = 40;

function when(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The MCP endpoint's pane: what it is, whether it is listening, how to connect,
 * and what agents have actually asked.
 *
 * The activity log is not a nicety here — it is the GATE. This endpoint carries
 * no token, so seeing what was asked is what stands in for controlling who may
 * ask, and the pane says as much rather than leaving the reader to infer it.
 */
export function McpPane({ mcp, onPatch }: Props): React.JSX.Element {
  const [status, setStatus] = useState<McpStatusDTO | null>(null);
  const [log, setLog] = useState<McpLogEntryDTO[]>([]);
  const [copied, setCopied] = useState(false);
  // The port is edited locally and committed on BLUR. Per keystroke it would be
  // normalized mid-edit — the first digit of "51000" is 5, which is not a
  // bindable port, so it would snap back to the default as you typed.
  const [port, setPort] = useState(String(mcp.port));

  const refresh = (): void => {
    void api.mcp.status().then(setStatus);
  };
  useEffect(refresh, [mcp.enabled, mcp.port]);
  useEffect(() => {
    void api.mcp.log().then(setLog);
    return api.mcp.onLog((entry) => setLog((prev) => [...prev, entry]));
  }, []);
  useEffect(() => setPort(String(mcp.port)), [mcp.port]);

  const commitPort = (): void => {
    const n = Number(port);
    if (!Number.isInteger(n) || n === mcp.port) {
      setPort(String(mcp.port));
      return;
    }
    void onPatch({ port: n });
  };

  const copy = (): void => {
    if (status?.connectCommand == null) return;
    void navigator.clipboard.writeText(status.connectCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const shown = [...log].reverse().slice(0, SHOWN);

  return (
    <div className="card">
      <h2>Agent access (MCP)</h2>
      <p className="sub">
        Lets an external agent — Claude Code, or anything that speaks MCP — search what you have
        recorded, read what a session was about, and see how you carried out a task before. It is
        read-only: nothing here can record, delete, re-index, or control your desktop.
      </p>

      {/* The security posture, stated where it applies rather than in a doc. The
          endpoint has no token by deliberate choice, so the two things that
          follow from that are the reader's to know. */}
      <div className="banner">
        <span className="led" />
        <span>
          No password is required to read this endpoint, so any program running on this Mac can
          query your recorded activity. Recorded typing is included in what it returns — a password
          typed during a recording can appear in a search result.
        </span>
      </div>

      <div className="form-row">
        <div>
          <label>Serve recorded experience</label>
          <div className="desc">
            {status?.listening === true ? (
              <>
                Listening on <span className="mono">127.0.0.1:{status.port}</span> — loopback only,
                never the network.
              </>
            ) : status?.error != null ? (
              <span style={{ color: "var(--amber)" }}>{status.error}</span>
            ) : (
              "Off. No port is open."
            )}
          </div>
        </div>
        <button
          className={`switch${mcp.enabled ? " on" : ""}`}
          onClick={() => void onPatch({ enabled: !mcp.enabled })}
          aria-pressed={mcp.enabled}
          aria-label="Toggle agent access"
        />
      </div>

      <div className="form-row">
        <div>
          <label>Port</label>
          <div className="desc">1024–65535. Changing it moves the endpoint — reconnect your agent.</div>
        </div>
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>

      {status?.connectCommand != null && (
        <div className="form-row">
          <div>
            <label>Connect</label>
            <div className="desc">Run this once in a terminal, then ask your agent about your work.</div>
          </div>
          <div style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
            <span className="mono" style={{ userSelect: "all" }}>
              {status.connectCommand}
            </span>
            <button className="btn ghost" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div className="form-row">
        <div>
          <label>Activity</label>
          <div className="desc">
            Every question an agent has asked this session. Held in memory only — it clears when
            DeskRAG quits.
          </div>
        </div>
        <div className="mcp-log">
          {shown.length === 0 ? (
            <div className="desc">Nothing yet.</div>
          ) : (
            shown.map((e) => (
              <div className="mcp-log__row" key={e.id}>
                <span className={`led ${e.ok ? "ok" : "warn"}`} />
                <span className="mono mcp-log__when">{when(e.at)}</span>
                <span className="mcp-log__tool">{e.tool}</span>
                {/* Truncated in the row and carried whole in the tooltip: this
                    list is scanned, and a wrapping argument would push the
                    timing column out of alignment down the whole log. */}
                <span className="mcp-log__args mono" title={`${e.args}\n→ ${e.result}`}>
                  {e.args}
                </span>
                <span className="mcp-log__ms mono">{e.ms}ms</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
