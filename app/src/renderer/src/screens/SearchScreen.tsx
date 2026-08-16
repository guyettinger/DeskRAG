import React, { useEffect, useRef, useState } from "react";
import type { Capabilities, FrameHitDTO } from "@shared/types";
import { api, timecode, wallClock } from "../api.js";
import { IconSearch, IconImage, IconLibrary } from "../icons.js";
import { DetailView, type SearchContext } from "./DetailView.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { laneText } from "@shared/evidence";
import { evidenceBars, locatorTicks, rowText, type LocatorTicks } from "../search-view.js";

interface Props {
  /**
   * Jump to the Library, at this moment of this recording. Retrieval finds the
   * moment; without this the screen would then strand the reader on it.
   *
   * `atSec` is LANE seconds, straight off the hit — main computes it with the
   * same `laneSec` the rail and the keyframe markers use, so this screen never
   * decides what a moment is.
   */
  onOpenRecording: (sessionId: string, atSec: number) => void;
}

export function SearchScreen({ onOpenRecording }: Props): React.JSX.Element {
  const [text, setText] = useState("");
  const [results, setResults] = useState<FrameHitDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Prior recordings live in a namespace the current provider cannot read. */
  const [staleProvider, setStaleProvider] = useState(false);
  const [unlinked, setUnlinked] = useState(0);
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
      const r = await api.search.query({ text: text.trim() });
      setResults(r.frames);
      setStaleProvider(Boolean(r.indexedUnderDifferentProvider));
      setUnlinked(r.segmentsMatchedButNoFrames ?? 0);
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
      const r = await api.search.query({ imageBytes: bytes });
      setResults(r.frames);
      setStaleProvider(Boolean(r.indexedUnderDifferentProvider));
      setUnlinked(r.segmentsMatchedButNoFrames ?? 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  /**
   * The row's own retrieval context, handed to the overlay it opens.
   *
   * Rank and the bar's fill are LIST-RELATIVE — they mean "against the others
   * this query returned" — which is exactly why they are props from here rather
   * than fields on `ResultDetailDTO`: `detailWith` also answers the Library and
   * MCP, where there is no list to be relative to. The same argument that kept
   * `score` off the DTO. `SearchScreen` already has all of it and used to throw
   * it away, passing only the frame id.
   */
  const openedFrom = ((): SearchContext | undefined => {
    if (selected === null || results === null) return undefined;
    const i = results.findIndex((h) => h.frameId === selected);
    if (i < 0) return undefined;
    const { fill, tied } = evidenceBars(results);
    return { hit: results[i]!, rank: i + 1, fill: fill[i] ?? 0, tied };
  })();

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
          Text and behavioral search are on. Choose an image model in Settings to enable
          image-example search and region highlights — it downloads once, then runs offline.
        </div>
      )}

      {error && (
        <div className="banner">
          <span className="led" /> {error}
        </div>
      )}

      {/* THE ONLY THING ON THIS SCREEN THAT SCROLLS. Loading, empty and results
          all occupy this one box, so the query above it stays put — it used to
          leave the top of the window the moment a search returned more than a
          screenful, which is exactly when you want to change it. */}
      <div className="search__pane">
        {loading && (
          <div className="loading">
            <div className="spinner" />
          </div>
        )}

        {!loading && results && (
          <>
            {results.length === 0 ? (
              <div className="empty">
                <GhostLottie size={104} className="empty__ghost" playing />
                {staleProvider ? (
                  <>
                    {/* Not "no matches": vectors exist, but in a namespace this
                        provider cannot read. Switching providers is deliberate and
                        has no migration path, so say so rather than imply the
                        library is empty. */}
                    <h3>Indexed with a different provider</h3>
                    <p>
                      These recordings were indexed by another embedding model. Switch back in
                      Settings, or record a new session to index with the current one.
                    </p>
                  </>
                ) : unlinked > 0 ? (
                  <>
                    {/* The query DID match. Nothing came back because no keyframe
                        is linked to any matching segment, which is an index
                        defect with a specific remedy — not an empty library. */}
                    <h3>Matched, but the index is incomplete</h3>
                    <p>
                      {unlinked} segment{unlinked === 1 ? "" : "s"} matched, but no keyframe is
                      linked to any of them. Recordings indexed before this was fixed have no such
                      links. Run <strong>Settings &rarr; Rebuild search index</strong>.
                    </p>
                  </>
                ) : (
                  <>
                    <h3>No matches</h3>
                    <p>Try different words, or record more sessions first.</p>
                  </>
                )}
              </div>
            ) : (
              <ResultList
                hits={results}
                onOpen={setSelected}
                onOpenRecording={onOpenRecording}
              />
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
      </div>

      {selected && (
        <DetailView
          frameId={selected}
          onClose={() => setSelected(null)}
          onOpenRecording={onOpenRecording}
          {...(openedFrom ? { openedFrom } : {})}
        />
      )}
    </div>
  );
}

/**
 * The header and the rows come from ONE `evidenceBars` call, because they state
 * the same fact and must not be able to disagree about it: the header says how
 * the list is ordered and every row draws a bar against that ordering.
 *
 * Saying it once at the top is what lets a row show a bar at all. The score is
 * max-normalized within the result set, so the best hit of every query sits at
 * the same ceiling however good it is — the bar means "against the best match
 * here", and that sentence has to appear somewhere.
 */
function ResultList({
  hits,
  onOpen,
  onOpenRecording,
}: {
  hits: FrameHitDTO[];
  onOpen: (frameId: string) => void;
  onOpenRecording: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  const { fill, tied } = evidenceBars(hits);
  return (
    <>
      <div className="search__meta">
        <span className="mono">{hits.length}</span> frames
        <span className="search__rule" />
        <span>
          {tied
            ? "all matched equally — nothing here separates them"
            : "ranked against the best match here"}
        </span>
      </div>
      <div className="results">
        {hits.map((hit, i) => (
          <ResultRow
            key={hit.frameId}
            hit={hit}
            rank={i + 1}
            fill={fill[i] ?? 0}
            tied={tied}
            locator={locatorTicks(hits, i)}
            // Capped so a long result list does not spend a second arriving.
            delayMs={Math.min(i, 12) * 20}
            onOpen={() => onOpen(hit.frameId)}
            onOpenRecording={onOpenRecording}
          />
        ))}
      </div>
    </>
  );
}

function ResultRow({
  hit,
  rank,
  fill,
  tied,
  locator,
  delayMs,
  onOpen,
  onOpenRecording,
}: {
  hit: FrameHitDTO;
  rank: number;
  fill: number;
  tied: boolean;
  locator: LocatorTicks | null;
  delayMs: number;
  onOpen: () => void;
  onOpenRecording: (sessionId: string, atSec: number) => void;
}): React.JSX.Element {
  // The one label rule, minus its timecode rung — the header already prints
  // that. Reading `segmentDigest` directly is what made this the only surface in
  // the app that ignored a caption it had, and then printed "no digest" over a
  // frame the rail was captioning happily.
  const text = rowText(hit);

  return (
    <div className="result" style={{ animationDelay: `${delayMs}ms` }}>
      <button className="result__open" onClick={onOpen}>
        <div className="result__thumb">
          {hit.thumbUrl ? (
            <img src={hit.thumbUrl} alt="" loading="lazy" />
          ) : (
            <span className="noshot">no keyframe</span>
          )}
        </div>

        <div className="result__body">
          <div className="result__head">
            {hit.app !== null && (
              <span className="result__app" data-tone={hit.appTone ?? "neutral"}>
                {hit.app}
              </span>
            )}
            <span className="result__tc mono">{timecode(hit.tMono)}</span>
            <span className="result__when">{wallClock(hit.wallClock)}</span>
          </div>

          {/* Every line below is WITHHELD when it has nothing to say. A row is
              allowed to be short: the thumbnail sets the height, so absence
              costs no reserved box — which is what the old card's
              `min-height: 2.6em` "no digest" hole was. */}
          {text.headline !== null ? (
            <p className="result__headline">{text.headline}</p>
          ) : (
            <p className="result__headline result__headline--none">
              No description — this recording was indexed without a captioner
            </p>
          )}
          {text.digest !== null && <p className="result__digest">{text.digest}</p>}
          {text.said !== null && <p className="result__said">{text.said}</p>}
          {text.task !== null && (
            <p className="result__task">
              <span className="result__task-in">in</span> {text.task}
            </p>
          )}

          <Evidence hit={hit} rank={rank} fill={fill} tied={tied} />
        </div>
      </button>

      {locator && <Locator ticks={locator} />}

      {/* Withheld, never offered dead: a hit whose frame row has gone names no
          recording, and main sends an empty id rather than inventing one. */}
      {hit.sessionId !== "" && (
        <button
          className="result__jump"
          onClick={() => onOpenRecording(hit.sessionId, hit.offsetSec)}
          title={`Open this recording in the Library at ${timecode(hit.offsetSec * 1000)}`}
          aria-label="Open this recording in the Library"
        >
          <IconLibrary style={{ width: 15, height: 15 }} />
        </button>
      )}
    </div>
  );
}

/**
 * Rank, a relative bar, and WHICH RANKED LISTS put this frame here.
 *
 * The lanes are the answer to "is this a good hit", which the score cannot give:
 * a frame several independent lists agree on is trustworthy, one scraping in on
 * `exact words` alone is a stretch. The raw score and the per-lane ranks go in
 * the `title` — real, useful when debugging, and not worth a reader's attention.
 */
function Evidence({
  hit,
  rank,
  fill,
  tied,
}: {
  hit: FrameHitDTO;
  rank: number;
  fill: number;
  tied: boolean;
}): React.JSX.Element {
  const lanes = hit.evidence.lanes;
  const detail = lanes.length
    ? lanes.map((l) => `${laneText(l)} #${l.rank}`).join("\n")
    : "no ranked list of its own";
  return (
    <div className="evidence" title={`score ${hit.score.toFixed(3)}\n${detail}`}>
      <span className="evidence__rank mono">{rank}</span>
      <span className="evidence__bar" data-tied={tied || undefined} aria-hidden="true">
        <span className="evidence__fill" style={{ width: `${fill * 100}%` }} />
      </span>
      <span className="evidence__lanes">
        {/* An empty lane list is not a gap. The frame scope expands to leaves,
            so a frame pulled in under a composed parent hit genuinely appeared
            in no list of its own — it came along with its segment. */}
        {lanes.length === 0
          ? "recalled with its segment"
          : lanes.map((l) => laneText(l)).join(" · ")}
      </span>
    </div>
  );
}

/**
 * The recording's own axis, 3px of it, with this moment marked.
 *
 * The same axis the Library rail draws, so the jump lands somewhere already
 * seen — and the dimmer ticks are every other hit from this recording, which is
 * what turns "five separate results" into "one stretch of one session" at a
 * glance. Decorative: the row's text says everything this says.
 */
function Locator({ ticks }: { ticks: LocatorTicks }): React.JSX.Element {
  return (
    <div className="locator" aria-hidden="true">
      {ticks.others.map((at, i) => (
        <span key={i} className="locator__tick" style={{ left: `${at * 100}%` }} />
      ))}
      <span className="locator__tick locator__tick--self" style={{ left: `${ticks.self * 100}%` }} />
    </div>
  );
}
