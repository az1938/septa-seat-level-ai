import type { Interpretation, RouteResult, Routing } from "../state/interactionMachine";

// ─────────────────────────────────────────────────────────────────────────────
// Researcher-only pipeline views, rendered on /monitor (src/pages/MonitorPage.tsx).
// (This file used to hold the floating DEV controller of the single combined page;
// the three-device setup replaced that page, so only the debug views remain.)
// They are fed from the shared backend session, never shown to riders.
// ─────────────────────────────────────────────────────────────────────────────

// DEV-only view of the retrieve-then-reason pipeline:
// raw transcript → search variants → REAL places retrieved → AI selection → verification.
export function AiResult({ interpretation: it }: { interpretation: Interpretation | null }) {
  if (!it) return null;
  if (it.phase === "pending")
    return <p className="dev-cam-status">RECOVERY: searching real places + AI ranking…</p>;
  if (it.phase === "error")
    return <p className="dev-cam-error">RECOVERY ERROR ({it.code}): {it.message}</p>;
  const r = it.result;
  const v = r.verification;
  const places = r.candidate_places ?? [];
  const num = (n: number | null | undefined) => (typeof n === "number" ? n.toFixed(2) : "—");
  return (
    <p className="dev-cam-status">
      RAW TRANSCRIPT: “{r.raw_transcript}”
      <br />
      SEARCH VARIANTS:{" "}
      {(r.search_variants ?? [])
        .map((sv) => (sv.dropped ? `“${sv.text}” (dropped: adds words not heard)` : `“${sv.text}”`))
        .join(" · ") || "—"}
      {(r.mentioned_streets ?? []).length > 0 && (
        <>
          <br />
          STREET MENTIONED: {r.mentioned_streets!.join(", ")}
        </>
      )}
      {r.explicit_location && (
        <>
          <br />
          NAMED LOCATION: “{r.explicit_location}” — {r.explicit_location_note}
        </>
      )}
      <br />
      RETRIEVED PLACES ({r.retrieved_count ?? places.length}
      {r.rejected_count ? `, ${r.rejected_count} rejected` : ""}):
      {places.length === 0 && " none"}
      {places.slice(0, 10).map((p, i) => (
        <span key={i}>
          <br />
          &nbsp;{i + 1}. {p.selected ? <strong data-on="true">{p.name}</strong> : p.name} —{" "}
          {p.address.split(",")[0] || "?"}, {p.city_state || "?"}
          <br />
          &nbsp;&nbsp;&nbsp;in_philadelphia: {p.in_philadelphia ?? "?"} · {(p.distance_from_stop_m / 1000).toFixed(1)}{" "}
          km from stop
          {p.eligible === false ? (
            <>
              {" "}
              · <strong>REJECTED: {p.rejected_reason}</strong>
            </>
          ) : (
            <>
              {" "}
              · name {num(p.name_similarity ?? p.phonetic_similarity)}
              {p.street_match != null ? ` · street ${p.street_match ? "✓" : "✗"}` : ""} · AI {num(p.ai_confidence)}
              {p.final_confidence != null ? ` · final ${num(p.final_confidence)}` : ""}
            </>
          )}
        </span>
      ))}
      {(r.retrieval_errors ?? []).length > 0 && (
        <>
          <br />
          SEARCH ERRORS: {r.retrieval_errors!.length}
        </>
      )}
      <br />
      AI SELECTED: <strong data-on={!!r.ai_selected}>{r.ai_selected ?? "none"}</strong>
      {r.ai_status ? ` (${r.ai_status}, AI ${num(r.ai_confidence)})` : ""}
      <br />
      FINAL CONFIDENCE: {num(r.confidence)}
      <br />
      PLACE VERIFICATION: <strong data-on={v?.status === "VERIFIED"}>{v?.status ?? "—"}</strong>
      <br />
      RESOLVED PLACE: {v?.resolved_place ?? "—"}
      <br />
      RESOLVED ADDRESS: {v?.resolved_address ?? "—"}
      <br />
      MATCH METHOD: {v?.status === "VERIFIED" ? `AI recovery → ${v.method}` : "—"}
      {r.status !== "ok" && (
        <>
          <br />
          RESULT: <strong>{r.status === "needs_clarification" ? "NEEDS CLARIFICATION" : "NOT A DESTINATION"}</strong>{" "}
          “{r.clarification_question}”
        </>
      )}
    </p>
  );
}

// DEV-only: how the AI's destination was resolved to a place / address / stops.
export function DestinationResolution({ r }: { r: RouteResult }) {
  const inp = r.destination_input ?? {};
  const raw = inp.place_name || inp.destination_text || inp.intersection_or_address || "—";
  return (
    <>
      RAW DESTINATION: {raw}
      <br />
      RESOLVED PLACE: {r.resolved_place ?? "—"}
      {r.matched_alias ? ` (alias “${r.matched_alias}”)` : ""}
      <br />
      RESOLVED ADDRESS: {r.resolved_address ?? "—"}
      <br />
      MATCH METHOD: {r.match_method ?? "none"}
      <br />
      NEARBY STOPS:{" "}
      {r.candidate_stops && r.candidate_stops.length
        ? r.candidate_stops
            .slice(0, 4)
            .map((c) => `${c.stop_id} ${c.name} (${c.distance_m} m)`)
            .join(" · ")
        : "none"}
      <br />
    </>
  );
}

// DEV-only: walking estimate from the origin (checked before Route 21).
export function Walking({ r }: { r: RouteResult }) {
  const w = r.walking;
  if (!w) return null;
  return (
    <>
      WALKING: distance {w.distance_m ?? "—"} m (straight line {w.straight_line_m ?? "—"} m) · estimated{" "}
      {w.minutes ?? "—"} min · walkable ≤{w.threshold_min ?? 10} min:{" "}
      <strong data-on={w.walkable}>{w.walkable ? "YES" : "NO"}</strong>
      <br />
      WALK SOURCE: {w.source}
      <br />
    </>
  );
}

// DEV-only view of the transit routing (static GTFS + live SEPTA).
export function RoutingResult({ routing: rt }: { routing: Routing | null }) {
  if (!rt) return null;
  if (rt.phase === "pending") return <p className="dev-cam-status">ROUTING: checking GTFS + live SEPTA…</p>;
  if (rt.phase === "error") return <p className="dev-cam-error">ROUTING ERROR ({rt.code}): {rt.message}</p>;
  const r = rt.result;
  if (r.status === "walk_recommended") {
    const t = r.route21_if_not_walking;
    return (
      <p className="dev-cam-status">
        <DestinationResolution r={r} />
        <Walking r={r} />
        ROUTING RESULT: <strong data-on="true">WALK RECOMMENDED</strong> (no ETA fetched, LED untouched)
        <br />
        ROUTE 21 IF NOT WALKING: {t ? `${t.status}${t.destination_stop ? ` → stop ${t.destination_stop}` : ""}${t.from_stop ? ` from ${t.from_stop}` : ""}` : "—"}
      </p>
    );
  }
  if (r.status === "opposite_direction") {
    return (
      <p className="dev-cam-status">
        <DestinationResolution r={r} />
        <Walking r={r} />
        ROUTING: <strong data-on="true">OPPOSITE DIRECTION</strong>
        <br />
        CURRENT STOP: {r.current_stop_id} ({r.current_stop_name})
        <br />
        RECOMMENDED STOP: {r.recommended_stop_id} ({r.recommended_stop_name})
        <br />
        DESTINATION STOP: {r.destination_stop} ({r.destination_name}
        {r.destination_distance_m ? `, ${r.destination_distance_m} m away` : ""})
        <br />
        ROUTE 21 REACHES IT FROM THE OTHER STOP ONLY
      </p>
    );
  }
  const label: Record<string, string> = {
    no_direct_route: "ROUTE 21 DOES NOT REACH IT (either direction)",
    destination_not_found: "DESTINATION NOT MATCHED TO A STOP",
    no_eta_available: "NO LIVE OR SCHEDULED ETA",
  };
  return (
    <div>
      <p className="dev-cam-status">
        <DestinationResolution r={r} />
        <Walking r={r} />
        ROUTING: <strong data-on={r.status === "ok"}>{r.status === "ok" ? "OK" : label[r.status]}</strong>
        {r.destination_stop ? (
          <>
            <br />
            DESTINATION STOP: {r.destination_stop} ({r.destination_name}
            {r.destination_distance_m ? `, ${r.destination_distance_m} m away` : ""})
          </>
        ) : (
          r.candidate_stops &&
          r.candidate_stops.length > 0 && (
            <>
              <br />
              NEAR STOPS: {r.candidate_stops.slice(0, 3).map((c) => c.stop_id).join(", ")}
            </>
          )
        )}
        <br />
        ORIGIN: {r.origin_stop} ({r.origin_name}) · ROUTE 21 ONLY
        {r.status === "ok" && (
          <>
            <br />
            ROUTE <strong data-on="true">{r.selected_route}</strong> · ETA: {r.eta_minutes} min · SOURCE:{" "}
            {r.eta_source}
            {r.selected_trip_id ? ` · trip ${r.selected_trip_id}` : ""}
          </>
        )}
      </p>
      {r.live_error && <p className="dev-cam-error">{r.live_error}</p>}
      {r.match_errors?.map((m) => (
        <p key={m} className="dev-cam-error">
          {m}
        </p>
      ))}
    </div>
  );
}
