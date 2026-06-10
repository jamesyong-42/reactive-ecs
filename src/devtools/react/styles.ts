// Self-contained styling for the devtools React components. One <style> element is injected
// on first use (deduped by id), so consumers get a working inspector with zero CSS setup.
// GitHub-dark palette, ported from the original playground inspector.

const STYLE_ID = 'reactive-ecs-devtools';

const CSS = `
/* ECS Inspector — a draggable, resizable, size-contained inspector window */
.recs-inspector {
	position: fixed; z-index: 10;
	display: flex; flex-direction: column;
	width: 340px; height: 440px;
	min-width: 240px; min-height: 140px;
	max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
	resize: both; overflow: hidden;
	background: rgba(13, 17, 23, .92); border: 1px solid #30363d; border-radius: 12px;
	box-shadow: 0 12px 40px rgba(0, 0, 0, .5);
	backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
	color: #c9d1d9; font: 12px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
.recs-inspector.collapsed { height: auto !important; min-height: 0 !important; resize: none; }
.recs-inspector.dragging { user-select: none; }
/* resize affordance in the corner (purely visual; native grip handles the drag) */
.recs-inspector::after {
	content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px;
	border-right: 2px solid #484f58; border-bottom: 2px solid #484f58; border-bottom-right-radius: 3px;
	pointer-events: none;
}
.recs-inspector.collapsed::after { display: none; }

.recs-head {
	flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
	padding: 9px 8px 9px 11px;
	background: rgba(22, 27, 34, .96); border-bottom: 1px solid #21262d; border-radius: 12px 12px 0 0;
	cursor: grab; user-select: none;
}
.recs-inspector.collapsed .recs-head { border-bottom: none; border-radius: 12px; }
.recs-inspector.dragging .recs-head { cursor: grabbing; }
.recs-grip { color: #484f58; font-size: 13px; letter-spacing: -2px; }
.recs-live {
	width: 7px; height: 7px; border-radius: 50%; background: #3fb950;
	box-shadow: 0 0 7px rgba(63, 185, 80, .7); animation: recs-pulse 1.6s ease-in-out infinite;
}
@keyframes recs-pulse { 0%, 100% { opacity: .4 } 50% { opacity: 1 } }
.recs-name { color: #e6edf3; font-weight: 600; letter-spacing: .02em; }
.recs-summary { color: #6e7681; font-size: 11px; }
.recs-spacer { margin-left: auto; }
.recs-btn {
	display: flex; align-items: center; justify-content: center;
	width: 22px; height: 22px; padding: 0; margin: 0;
	background: none; border: none; border-radius: 6px;
	color: #8b949e; font: inherit; font-size: 12px; cursor: pointer;
}
.recs-btn:hover { background: rgba(110, 118, 129, .18); color: #e6edf3; }

.recs-scroll { flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 8px; }
.recs-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.recs-scroll::-webkit-scrollbar-thumb {
	background: #30363d; border: 2px solid transparent; background-clip: padding-box; border-radius: 6px;
}
.recs-scroll::-webkit-scrollbar-thumb:hover { background: #484f58; background-clip: padding-box; }

.recs-entity { padding: 5px 6px; margin-bottom: 6px; border-radius: 8px; background: rgba(110, 118, 129, .07); }
.recs-entity:last-child { margin-bottom: 0; }
.recs-erow {
	display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
	width: 100%; box-sizing: border-box; padding: 3px 4px; margin: 0;
	background: none; border: none; border-radius: 6px;
	color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.recs-erow:hover { background: rgba(110, 118, 129, .14); }
.recs-chevron { flex: 0 0 auto; width: 10px; color: #6e7681; font-size: 10px; }
.recs-id { color: #6e7681; }
.recs-label { color: #58a6ff; font-weight: 600; }
.recs-tag {
	color: #d2a8ff; background: rgba(188, 140, 255, .13); border: 1px solid rgba(188, 140, 255, .28);
	border-radius: 4px; padding: 0 6px; font-size: 11px;
}
.recs-count { margin-left: auto; color: #6e7681; font-size: 11px; }
.recs-comp { display: flex; gap: 8px; padding: 2px 4px 2px 14px; }
.recs-cname { flex: 0 0 auto; min-width: 104px; color: #7ee787; }
.recs-cval { color: #adbac7; white-space: pre-wrap; word-break: break-word; }
.recs-empty { padding: 28px 12px; text-align: center; color: #6e7681; }

/* tabs — entities / timeline / consumer-provided */
.recs-tabs {
	flex: 0 0 auto; display: flex; gap: 4px; padding: 6px 8px 0;
	background: rgba(22, 27, 34, .55); border-bottom: 1px solid #21262d;
}
.recs-tab {
	padding: 5px 12px 7px; background: none; border: none; border-bottom: 2px solid transparent;
	color: #8b949e; font: inherit; font-size: 11px; cursor: pointer;
}
.recs-tab:hover { color: #e6edf3; }
.recs-tab.active { color: #e6edf3; border-bottom-color: #58a6ff; }

/* timeline tab — fills the panel; canvas-rendered waterfall */
.recs-tl { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.recs-tl-bar {
	flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
	padding: 7px 8px; border-bottom: 1px solid #21262d;
}
.recs-seg { display: flex; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
.recs-seg button {
	padding: 3px 9px; background: none; border: none; border-right: 1px solid #30363d;
	color: #8b949e; font: inherit; font-size: 11px; cursor: pointer;
}
.recs-seg button:last-child { border-right: none; }
.recs-seg button:hover { color: #e6edf3; }
.recs-seg button.on { background: rgba(88, 166, 255, .18); color: #e6edf3; }
.recs-tl-live {
	display: flex; align-items: center; gap: 6px; padding: 3px 9px;
	background: none; border: 1px solid #30363d; border-radius: 6px;
	color: #6e7681; font: inherit; font-size: 11px; cursor: pointer;
}
.recs-tl-live .dot { width: 7px; height: 7px; border-radius: 50%; background: #484f58; }
.recs-tl-live.on { color: #3fb950; border-color: rgba(63, 185, 80, .35); }
.recs-tl-live.on .dot { background: #3fb950; box-shadow: 0 0 6px rgba(63, 185, 80, .7); }
.recs-tl-btn {
	padding: 3px 9px; background: none; border: 1px solid #30363d; border-radius: 6px;
	color: #8b949e; font: inherit; font-size: 11px; cursor: pointer;
}
.recs-tl-btn:hover { background: rgba(110, 118, 129, .18); color: #e6edf3; }
.recs-tl-wrap { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; }
.recs-tl-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.recs-tl-tip {
	display: none; position: absolute; z-index: 2; pointer-events: none;
	max-width: 240px; padding: 6px 8px; border-radius: 7px;
	background: rgba(22, 27, 34, .98); border: 1px solid #30363d;
	box-shadow: 0 8px 24px rgba(0, 0, 0, .5);
	color: #adbac7; font-size: 11px; line-height: 1.45;
}
.recs-tl-tip b { color: #e6edf3; }
.recs-tl-tip .k { color: #6e7681; }
.recs-tl-legend {
	flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 4px 11px;
	padding: 6px 8px; border-top: 1px solid #21262d; color: #8b949e; font-size: 10px;
}
.recs-tl-legend i {
	display: inline-block; width: 9px; height: 9px; border-radius: 2px;
	margin-right: 5px; vertical-align: -1px;
}
`;

/**
 * Injects the devtools stylesheet once per document (deduped by element id). Safe to call
 * from every component render; a no-op during SSR (no `document`).
 */
export function injectDevtoolsStyles(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}
