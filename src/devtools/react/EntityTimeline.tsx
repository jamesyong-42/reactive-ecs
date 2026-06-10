// The Timeline tab — a Chrome-network-style waterfall of entity lifecycles. Each entity is ONE
// horizontal segment from birth to death (or to the live "now" edge if still alive), one row each,
// in birth order. This is where entity churn becomes legible: a burst of short-lived entities
// drops a stack of bars, most die within a tick or two (red cap = 'lose' outcome), one lives on
// (green cap = 'win').
//
// Rendered to <canvas> (not DOM-per-segment) so thousands of dead entities pan & zoom at 60fps.
// Interaction is logic-analyzer standard: two-finger scroll pans (X = time, Y = rows), ctrl-wheel
// (trackpad pinch) zooms the time axis, drag pans time. Live-tail follows "now"; scrolling back to
// the right edge re-engages it. Unit switch flips the X axis between wall-clock ms and ECS ticks —
// each record carries both, so it's a pure re-projection.

import { useEffect, useRef, useState } from 'react';
import type { World } from '../../types.js';
import {
	DEFAULT_DESCRIPTOR_COLOR,
	defaultDescriber,
	type EntityDescriber,
	type EntityDescriptor,
} from '../describer.js';
import type { LifecycleRecorder, LifeRecord } from '../recorder.js';
import { injectDevtoolsStyles } from './styles.js';

type Unit = 'ms' | 'ticks';

/** One legend swatch — the consumer's colour language for their describer. */
export interface TimelineLegendItem {
	color: string;
	label: string;
}

export interface EntityTimelineProps {
	world: World;
	recorder: LifecycleRecorder;
	/** Identity for LIVE rows (dead rows use the descriptor frozen at death). */
	describer?: EntityDescriber;
	/** Optional legend row; hidden when absent. */
	legend?: TimelineLegendItem[];
}

const GUTTER = 108; // px — left label column (entity id + name)
const ROW_H = 16; // px — one entity per row
const RULER_H = 22; // px — the time axis along the top
const BAR_PAD = 3; // px — vertical inset of a bar within its row

// per-unit view defaults + zoom clamps (span = how many units the plot shows across)
const UNIT_CFG: Record<Unit, { span: number; min: number; max: number }> = {
	ms: { span: 6000, min: 150, max: 120000 },
	ticks: { span: 360, min: 15, max: 6000 },
};

interface View {
	span: number; // visible units across the plot
	viewStart: number; // unit value at the left edge of the plot
	follow: boolean; // live-tail: pin the right edge to "now"
	scrollY: number; // vertical row scroll (px)
	stickBottom: boolean; // auto-follow newest row
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

const defaultView = (u: Unit): View => ({
	span: UNIT_CFG[u].span,
	viewStart: 0,
	follow: true,
	scrollY: 0,
	stickBottom: true,
});

// while an entity is alive its descriptor is read live; this is the dead-row fallback for
// records whose descriptor could not be frozen (shouldn't happen in practice)
const FALLBACK_DESCRIPTOR: EntityDescriptor = { label: 'entity', detail: null };

// "nice" ruler steps so labels land on round values as you zoom
const MS_STEPS = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000];
const TICK_STEPS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3000];
function niceStep(unit: Unit, pxPerUnit: number, minPx: number): number {
	const steps = unit === 'ms' ? MS_STEPS : TICK_STEPS;
	for (const s of steps) if (s * pxPerUnit >= minPx) return s;
	return steps[steps.length - 1];
}
function fmtTick(unit: Unit, v: number): string {
	if (unit === 'ticks') return `t${v}`;
	return v >= 1000 ? `${+(v / 1000).toFixed(v % 1000 ? 1 : 0)}s` : `${v}ms`;
}

export function EntityTimeline({
	world,
	recorder,
	describer = defaultDescriber,
	legend,
}: EntityTimelineProps) {
	const [unit, setUnit] = useState<Unit>('ms');
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const liveRef = useRef<HTMLButtonElement>(null);

	const unitRef = useRef<Unit>(unit);
	unitRef.current = unit;
	const describerRef = useRef<EntityDescriber>(describer);
	describerRef.current = describer;
	const view = useRef<View>(defaultView('ms'));

	useEffect(() => {
		injectDevtoolsStyles();
	}, []);

	// switching units re-bases the axis (tick↔ms isn't linear) — reset to a live-tail default for the unit
	useEffect(() => {
		view.current = defaultView(unit);
	}, [unit]);

	// ── the draw loop — reads refs + the world live, so it runs independent of React renders ──
	useEffect(() => {
		let raf = 0;
		const draw = () => {
			raf = requestAnimationFrame(draw);
			const cv = canvasRef.current;
			const wrap = wrapRef.current;
			if (!cv || !wrap) return;
			const cssW = wrap.clientWidth;
			const cssH = wrap.clientHeight;
			if (cssW <= 0 || cssH <= 0) return;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
				cv.width = Math.round(cssW * dpr);
				cv.height = Math.round(cssH * dpr);
			}
			const ctx = cv.getContext('2d');
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, cssW, cssH);

			const u = unitRef.current;
			const cfg = UNIT_CFG[u];
			const v = view.current;
			const plotW = cssW - GUTTER;
			const bodyH = cssH - RULER_H;
			const now = u === 'ms' ? recorder.nowMs() : world.currentTick;

			v.span = clamp(v.span, cfg.min, cfg.max);
			if (v.follow) v.viewStart = now - v.span;
			const pxPerUnit = plotW / v.span;
			const t2x = (t: number) => GUTTER + (t - v.viewStart) * pxPerUnit;

			const recs = recorder.records();
			const born = (r: LifeRecord) => (u === 'ms' ? r.bornMs : r.bornTick);
			const died = (r: LifeRecord) => (u === 'ms' ? r.diedMs : r.diedTick);

			const contentH = recs.length * ROW_H;
			const maxScroll = Math.max(0, contentH - bodyH);
			v.scrollY = v.stickBottom ? maxScroll : clamp(v.scrollY, 0, maxScroll);

			// ── bars (clipped to the plot area) ──
			ctx.save();
			ctx.beginPath();
			ctx.rect(GUTTER, RULER_H, plotW, bodyH);
			ctx.clip();

			// faint ruler gridlines down the body
			const step = niceStep(u, pxPerUnit, 72);
			ctx.strokeStyle = 'rgba(110,118,129,.12)';
			ctx.lineWidth = 1;
			const firstLine = Math.ceil(v.viewStart / step) * step;
			for (let t = firstLine; t2x(t) <= cssW; t += step) {
				const x = Math.round(t2x(t)) + 0.5;
				ctx.beginPath();
				ctx.moveTo(x, RULER_H);
				ctx.lineTo(x, cssH);
				ctx.stroke();
			}

			const firstRow = Math.max(0, Math.floor(v.scrollY / ROW_H));
			const lastRow = Math.min(recs.length - 1, Math.ceil((v.scrollY + bodyH) / ROW_H));
			for (let i = firstRow; i <= lastRow; i++) {
				const r = recs[i];
				const y = RULER_H + i * ROW_H - v.scrollY;
				const alive = r.diedMs === null;
				const desc = alive
					? describerRef.current(world, r.id)
					: (r.descriptor ?? FALLBACK_DESCRIPTOR);
				const color = desc.color ?? DEFAULT_DESCRIPTOR_COLOR;

				const x0 = t2x(born(r));
				const x1 = alive ? t2x(now) : t2x(died(r) as number);
				const left = clamp(x0, GUTTER, cssW);
				const right = clamp(Math.max(x1, x0 + 1), GUTTER, cssW);
				if (right <= GUTTER || left >= cssW) continue; // fully off-screen in time

				ctx.fillStyle = color;
				ctx.globalAlpha = alive ? 0.95 : 0.8;
				roundRect(ctx, left, y + BAR_PAD, right - left, ROW_H - BAR_PAD * 2, 3);
				ctx.fill();
				ctx.globalAlpha = 1;

				// outcome end-cap — the frozen descriptor's verdict, made visible
				const outcome = alive ? null : (desc.outcome ?? null);
				if (outcome && x1 <= cssW && x1 >= GUTTER) {
					ctx.fillStyle = outcome === 'win' ? '#3fb950' : '#f85149';
					roundRect(ctx, right - 3, y + BAR_PAD, 3, ROW_H - BAR_PAD * 2, 1.5);
					ctx.fill();
				}
				// alive bars get a bright leading edge at "now"
				if (alive && x1 >= GUTTER && x1 <= cssW) {
					ctx.fillStyle = '#e6edf3';
					ctx.fillRect(right - 1.5, y + BAR_PAD, 1.5, ROW_H - BAR_PAD * 2);
				}
			}
			ctx.restore();

			// ── gutter (entity id + label), drawn over a solid panel so bars never bleed under it ──
			ctx.fillStyle = 'rgba(13,17,23,.92)';
			ctx.fillRect(0, RULER_H, GUTTER, bodyH);
			ctx.strokeStyle = '#21262d';
			ctx.beginPath();
			ctx.moveTo(GUTTER + 0.5, RULER_H);
			ctx.lineTo(GUTTER + 0.5, cssH);
			ctx.stroke();
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, RULER_H, GUTTER, bodyH);
			ctx.clip();
			ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
			ctx.textBaseline = 'middle';
			for (let i = firstRow; i <= lastRow; i++) {
				const r = recs[i];
				const y = RULER_H + i * ROW_H - v.scrollY + ROW_H / 2;
				const alive = r.diedMs === null;
				const desc = alive
					? describerRef.current(world, r.id)
					: (r.descriptor ?? FALLBACK_DESCRIPTOR);
				ctx.fillStyle = '#6e7681';
				ctx.fillText(`#${r.id}`, 8, y);
				ctx.fillStyle = desc.color ?? DEFAULT_DESCRIPTOR_COLOR;
				const label = ellipsize(ctx, desc.label, GUTTER - 44);
				ctx.fillText(label, 40, y);
			}
			ctx.restore();

			// ── ruler (top), drawn last so it sits above everything ──
			ctx.fillStyle = 'rgba(22,27,34,.96)';
			ctx.fillRect(0, 0, cssW, RULER_H);
			ctx.strokeStyle = '#21262d';
			ctx.beginPath();
			ctx.moveTo(0, RULER_H + 0.5);
			ctx.lineTo(cssW, RULER_H + 0.5);
			ctx.stroke();
			ctx.fillStyle = '#6e7681';
			ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
			ctx.textBaseline = 'middle';
			ctx.save();
			ctx.beginPath();
			ctx.rect(GUTTER, 0, plotW, RULER_H);
			ctx.clip();
			for (let t = firstLine; t2x(t) <= cssW; t += step) {
				const x = t2x(t);
				ctx.strokeStyle = 'rgba(110,118,129,.4)';
				ctx.beginPath();
				ctx.moveTo(Math.round(x) + 0.5, RULER_H - 5);
				ctx.lineTo(Math.round(x) + 0.5, RULER_H);
				ctx.stroke();
				ctx.fillText(fmtTick(u, t), x + 3, RULER_H / 2);
			}
			ctx.restore();
			// unit badge in the ruler corner
			ctx.fillStyle = '#484f58';
			ctx.fillText(u, 8, RULER_H / 2);

			// ── now line ──
			const nowX = t2x(now);
			if (nowX >= GUTTER && nowX <= cssW) {
				ctx.strokeStyle = 'rgba(88,166,255,.55)';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(Math.round(nowX) + 0.5, 0);
				ctx.lineTo(Math.round(nowX) + 0.5, cssH);
				ctx.stroke();
			}

			// reflect live-tail state on the toolbar button without a React re-render
			const lb = liveRef.current;
			if (lb) lb.classList.toggle('on', v.follow);
		};
		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	}, [world, recorder]);

	// ── interaction: wheel (pan + pinch-zoom) and drag-to-pan ──
	useEffect(() => {
		const cv = canvasRef.current;
		const wrap = wrapRef.current;
		if (!cv || !wrap) return;

		const plotWidth = () => Math.max(1, wrap.clientWidth - GUTTER);
		const maxScrollY = () => {
			const bodyH = wrap.clientHeight - RULER_H;
			return Math.max(0, recorder.records().length * ROW_H - bodyH);
		};
		const reconcileFollow = (now: number) => {
			const v = view.current;
			v.follow = v.viewStart + v.span >= now - v.span * 0.01; // snapped to the right edge → live again
		};

		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const u = unitRef.current;
			const v = view.current;
			const cfg = UNIT_CFG[u];
			const now = u === 'ms' ? recorder.nowMs() : world.currentTick;
			const pxPerUnit = plotWidth() / v.span;

			if (e.ctrlKey) {
				// trackpad pinch → zoom the time axis
				const rect = cv.getBoundingClientRect();
				const px = clamp(e.clientX - rect.left, GUTTER, rect.width);
				const tUnder = v.viewStart + (px - GUTTER) / pxPerUnit;
				const newSpan = clamp(v.span * Math.exp(e.deltaY * 0.01), cfg.min, cfg.max);
				if (v.follow) {
					v.span = newSpan;
					v.viewStart = now - newSpan; // keep "now" pinned to the right edge while live
				} else {
					const newPxPerUnit = plotWidth() / newSpan;
					v.span = newSpan;
					v.viewStart = tUnder - (px - GUTTER) / newPxPerUnit; // keep the time under the cursor fixed
				}
				return;
			}
			// two-finger scroll → pan time (X) + rows (Y)
			if (e.deltaX !== 0) {
				v.viewStart += e.deltaX / pxPerUnit;
				reconcileFollow(now);
			}
			if (e.deltaY !== 0) {
				v.scrollY = clamp(v.scrollY + e.deltaY, 0, maxScrollY());
				v.stickBottom = v.scrollY >= maxScrollY() - 1;
			}
		};

		// drag-to-pan (time), with a tooltip-suppressing flag
		let drag: { x: number; vs: number } | null = null;
		const onPointerDown = (e: PointerEvent) => {
			if (e.clientX - cv.getBoundingClientRect().left < GUTTER) return; // gutter clicks aren't pans
			drag = { x: e.clientX, vs: view.current.viewStart };
			cv.setPointerCapture(e.pointerId);
			cv.style.cursor = 'grabbing';
			hideTip();
		};
		const onPointerMove = (e: PointerEvent) => {
			const u = unitRef.current;
			const v = view.current;
			const now = u === 'ms' ? recorder.nowMs() : world.currentTick;
			if (drag) {
				const pxPerUnit = plotWidth() / v.span;
				v.viewStart = drag.vs - (e.clientX - drag.x) / pxPerUnit;
				reconcileFollow(now);
				return;
			}
			showTip(e);
		};
		const endDrag = (e: PointerEvent) => {
			if (!drag) return;
			drag = null;
			cv.style.cursor = '';
			try {
				cv.releasePointerCapture(e.pointerId);
			} catch {
				/* already released */
			}
		};

		// ── hover tooltip ──
		const hideTip = () => {
			if (tipRef.current) tipRef.current.style.display = 'none';
		};
		const showTip = (e: PointerEvent) => {
			const tip = tipRef.current;
			const wrapEl = wrapRef.current;
			if (!tip || !wrapEl) return;
			const rect = cv.getBoundingClientRect();
			const my = e.clientY - rect.top;
			if (my < RULER_H) return hideTip();
			const v = view.current;
			const row = Math.floor((my - RULER_H + v.scrollY) / ROW_H);
			const recs = recorder.records();
			if (row < 0 || row >= recs.length) return hideTip();
			const r = recs[row];
			const alive = r.diedMs === null;
			const desc = alive
				? describerRef.current(world, r.id)
				: (r.descriptor ?? FALLBACK_DESCRIPTOR);
			const dMs = (alive ? recorder.nowMs() : (r.diedMs as number)) - r.bornMs;
			const dTk = (alive ? world.currentTick : (r.diedTick as number)) - r.bornTick;
			const diedTxt = alive ? 'alive' : `t${r.diedTick} · ${fmtMs(r.diedMs as number)}`;
			tip.innerHTML =
				`<b>#${r.id}</b> ${escapeHtml(desc.label)}` +
				(desc.detail ? ` <span class="k">${escapeHtml(desc.detail)}</span>` : '') +
				`<div>born&nbsp; t${r.bornTick} · ${fmtMs(r.bornMs)}</div>` +
				`<div>died&nbsp; ${diedTxt}</div>` +
				`<div>life&nbsp;&nbsp; ${dTk} tick${dTk === 1 ? '' : 's'} · ${fmtMs(dMs)}</div>`;
			tip.style.display = 'block';
			const tx = e.clientX - rect.left + 12;
			const ty = my + 12;
			// keep the tip inside the wrap
			tip.style.left = `${Math.min(tx, wrapEl.clientWidth - tip.offsetWidth - 6)}px`;
			tip.style.top = `${Math.min(ty, wrapEl.clientHeight - tip.offsetHeight - 6)}px`;
		};
		const onLeave = () => hideTip();

		cv.addEventListener('wheel', onWheel, { passive: false });
		cv.addEventListener('pointerdown', onPointerDown);
		cv.addEventListener('pointermove', onPointerMove);
		cv.addEventListener('pointerup', endDrag);
		cv.addEventListener('pointercancel', endDrag);
		cv.addEventListener('pointerleave', onLeave);
		return () => {
			cv.removeEventListener('wheel', onWheel);
			cv.removeEventListener('pointerdown', onPointerDown);
			cv.removeEventListener('pointermove', onPointerMove);
			cv.removeEventListener('pointerup', endDrag);
			cv.removeEventListener('pointercancel', endDrag);
			cv.removeEventListener('pointerleave', onLeave);
		};
	}, [world, recorder]);

	const jumpLive = () => {
		view.current.follow = true;
		view.current.stickBottom = true;
	};

	return (
		<div className="recs-tl">
			<div className="recs-tl-bar" data-nodrag>
				<div className="recs-seg">
					<button type="button" className={unit === 'ms' ? 'on' : ''} onClick={() => setUnit('ms')}>
						ms
					</button>
					<button
						type="button"
						className={unit === 'ticks' ? 'on' : ''}
						onClick={() => setUnit('ticks')}
					>
						ticks
					</button>
				</div>
				<button type="button" ref={liveRef} className="recs-tl-live" onClick={jumpLive}>
					<span className="dot" /> live
				</button>
				<button type="button" className="recs-tl-btn recs-spacer" onClick={() => recorder.clear()}>
					clear
				</button>
			</div>
			<div className="recs-tl-wrap" ref={wrapRef}>
				<canvas ref={canvasRef} className="recs-tl-canvas" />
				<div className="recs-tl-tip" ref={tipRef} />
			</div>
			{legend && (
				<div className="recs-tl-legend" data-nodrag>
					{legend.map((item) => (
						<span key={item.label}>
							<i style={{ background: item.color }} />
							{item.label}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

// === canvas + format helpers ===

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.arcTo(x + w, y, x + w, y + h, rr);
	ctx.arcTo(x + w, y + h, x, y + h, rr);
	ctx.arcTo(x, y + h, x, y, rr);
	ctx.arcTo(x, y, x + w, y, rr);
	ctx.closePath();
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
	if (ctx.measureText(text).width <= maxW) return text;
	let s = text;
	while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
	return `${s}…`;
}

function fmtMs(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
	return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
