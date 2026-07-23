import React, { useEffect, useRef, useState } from "react";
import type { Capabilities, FrameHitDTO } from "@shared/types";
import { api, timecode, wallClock } from "../api.js";
import { IconSearch, IconImage } from "../icons.js";
import { DetailView } from "./DetailView.js";
import { GhostLottie } from "../brand/GhostLottie.js";

export function SearchScreen(): React.JSX.Element {
  const [text, setText] = useState("");
  const [results, setResults] = useState<FrameHitDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.settings.capabilities().then(setCaps);
  }, []);

  const runText = async (): Promise<void> => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResults(await api.search.query({ text: text.trim() }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const runImage = async (file: File): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setResults(await api.search.query({ imageBytes: bytes }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <span className="eyebrow">Retrieve</span>
        <h1>Search your experiences</h1>
        <p>
          Find recorded moments by what happened, what was said, or what the screen looked like.
          Results are frames from your sessions — click one to see everything that was captured.
        </p>
      </div>

      <div className="searchbar">
        <IconSearch />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runText()}
          placeholder="e.g. reviewing the pull request in the editor"
          autoFocus
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => e.target.files?.[0] && void runImage(e.target.files[0])}
        />
        <button
          className="btn ghost"
          onClick={() => fileRef.current?.click()}
          disabled={!caps?.imageSearch}
          title={caps?.imageSearch ? "Search by image example" : "Configure an image provider in Settings to search by image"}
        >
          <span className="inline">
            <IconImage style={{ width: 15, height: 15 }} /> Image
          </span>
        </button>
        <button className="btn" onClick={() => void runText()} disabled={loading || !text.trim()}>
          Search
        </button>
      </div>

      {!caps?.imageSearch && (
        <div className="search__meta">
          Text and behavioral search run locally. Add a Voyage or Gemini key in Settings to enable
          image-example search and region highlights.
        </div>
      )}

      {error && (
        <div className="banner" style={{ marginTop: 16 }}>
          <span className="led" /> {error}
        </div>
      )}

      {loading && <div className="spinner" />}

      {!loading && results && (
        <>
          <div className="search__meta">
            <span className="mono">{results.length}</span> frames
          </div>
          {results.length === 0 ? (
            <div className="empty">
              <GhostLottie size={104} className="empty__ghost" playing />
              <h3>No matches</h3>
              <p>Try different words, or record more sessions first.</p>
            </div>
          ) : (
            <div className="sheet">
              {results.map((r) => (
                <FrameCard key={r.frameId} hit={r} onOpen={() => setSelected(r.frameId)} />
              ))}
            </div>
          )}
        </>
      )}

      {!loading && !results && (
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h3>Nothing searched yet</h3>
          <p>Record a session on the Record tab, then search for what you did.</p>
        </div>
      )}

      {selected && <DetailView frameId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function FrameCard({ hit, onOpen }: { hit: FrameHitDTO; onOpen: () => void }): React.JSX.Element {
  return (
    <button className="frame" onClick={onOpen}>
      <div className="frame__thumb">
        {hit.thumbUrl ? (
          <img src={hit.thumbUrl} alt="" loading="lazy" />
        ) : (
          <span className="frame__noimg">no keyframe</span>
        )}
        <span className="frame__tc mono">{timecode(hit.tMono)}</span>
        {hit.highlightCount > 0 && <span className="frame__badge mono">◱ {hit.highlightCount}</span>}
      </div>
      <div className="frame__body">
        <div className={`frame__digest${hit.segmentDigest ? "" : " empty"}`}>
          {hit.segmentDigest ?? "no digest"}
        </div>
        <div className="frame__foot">
          <span>{wallClock(hit.wallClock)}</span>
          <span className="score">{hit.score.toFixed(3)}</span>
        </div>
      </div>
    </button>
  );
}
