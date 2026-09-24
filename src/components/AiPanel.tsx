import { AnimatePresence, motion } from "framer-motion";
import type { InteractionContext } from "../state/interactionMachine";
import { AiFace, type FaceMood } from "./AiFace";
import { Waveform } from "./Waveform";
import { LED_COLOR, ledBucketForMinutes } from "../lib/led";

// FRAME 1 — public-facing AI interaction panel.
// Purely presentational: renders whatever state the machine is in.

// Application state → pixel expression.
function faceMood(ctx: InteractionContext): FaceMood {
  switch (ctx.state) {
    case "IDLE":
      return "idle";
    case "PERSON_DETECTED":
      // "Where are you going?" → personDetected;
      // retry prompt ("Sorry, I didn't catch that.") / final "Please try again." → noDestination
      return ctx.prompt === "ask" ? "personDetected" : "noDestination";
    case "LISTENING":
      return "listening";
    case "PROCESSING": {
      // destination_not_found → noDestination; otherwise still working → processing
      const r = ctx.routing;
      if (r?.phase === "done" && r.result.status === "destination_not_found") return "noDestination";
      return "processing";
    }
    case "RECOMMENDATION":
      // route found → recommendation; opposite_direction / no_direct_route notice → wrongDirection
      return ctx.recommendation ? "recommendation" : "wrongDirection";
  }
}

const fade = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
  transition: { duration: 0.35, ease: "easeOut" as const },
};

export function AiPanel({ ctx }: { ctx: InteractionContext }) {
  const { state, recommendation } = ctx;
  const isIdle = state === "IDLE";

  return (
    <div className="panel-screen" data-state={state}>
      <motion.div
        className="panel-face"
        initial={false}
        animate={{ width: isIdle ? "62%" : "30%", marginTop: isIdle ? "0%" : "-4%" }}
        transition={{ type: "spring", stiffness: 140, damping: 20 }}
      >
        {/* gentle float so the idle face feels alive */}
        <motion.div
          animate={isIdle ? { y: [0, -6, 0] } : { y: 0 }}
          transition={isIdle ? { duration: 4, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3 }}
        >
          <AiFace mood={faceMood(ctx)} />
        </motion.div>
      </motion.div>

      <div className="panel-content">
        <AnimatePresence mode="wait">
          {state === "PERSON_DETECTED" && ctx.prompt === "ask" && (
            <motion.div key="ask" {...fade}>
              <p className="panel-question">Where are you going?</p>
            </motion.div>
          )}

          {state === "PERSON_DETECTED" && ctx.prompt === "retry" && (
            <motion.div key={`retry-${ctx.retryCount}`} {...fade} className="panel-stack">
              <p className="panel-question">Sorry, I didn’t catch that.</p>
              <p className="panel-hint">Please say your destination again.</p>
            </motion.div>
          )}

          {state === "PERSON_DETECTED" && ctx.prompt === "giveup" && (
            <motion.div key="giveup" {...fade}>
              <p className="panel-question">Please try again.</p>
            </motion.div>
          )}

          {state === "LISTENING" && (
            <motion.div key="listen" {...fade} className="panel-stack">
              <Waveform />
              <p className="panel-caption">Listening…</p>
            </motion.div>
          )}

          {state === "PROCESSING" && (
            <motion.div key="process" {...fade} className="panel-stack">
              <div className="thinking-dots" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    animate={{ opacity: [0.25, 1, 0.25], y: [0, -6, 0] }}
                    transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
                  />
                ))}
              </div>
              <p className="panel-caption">Finding your route…</p>
            </motion.div>
          )}

          {state === "RECOMMENDATION" && !recommendation && ctx.redirect?.kind === "no_direct_route" && (
            <motion.div key="no-route" {...fade} className="panel-stack">
              <p className="panel-rec-eta">No direct route from this stop.</p>
              <p className="panel-hint">Please try another destination.</p>
            </motion.div>
          )}

          {state === "RECOMMENDATION" && !recommendation && ctx.redirect?.kind === "opposite_direction" && (
            <motion.div key="redirect" {...fade} className="panel-stack">
              <p className="panel-rec-eta">This destination is in the opposite direction.</p>
              <p className="panel-hint">Please use the {ctx.redirect.stopName} stop.</p>
            </motion.div>
          )}

          {state === "RECOMMENDATION" && recommendation && recommendation.etaMinutes < 1 && (
            <motion.div key="rec-arriving" {...fade} className="panel-stack">
              <p className="panel-rec-eta">Route {recommendation.route} is arriving now.</p>
              <p className="panel-hint">Please proceed to the boarding area.</p>
            </motion.div>
          )}

          {state === "RECOMMENDATION" && recommendation && recommendation.etaMinutes >= 1 && (
            <motion.div key="rec" {...fade} className="panel-stack">
              <p className="panel-rec-route">
                Take <strong>Route {recommendation.route}</strong>
              </p>
              <p className="panel-rec-eta">
                {recommendation.etaMinutes < 1 ? (
                  "Arriving now"
                ) : (
                  <>
                    Arriving in{" "}
                    <span
                      style={{ color: LED_COLOR[ledBucketForMinutes(recommendation.etaMinutes)] }}
                    >
                      {Math.round(recommendation.etaMinutes)} min
                    </span>
                  </>
                )}
              </p>
              <p className="panel-hint">Please have a seat and follow the display in front of you.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
