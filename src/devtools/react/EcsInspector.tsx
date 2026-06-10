// ECS Inspector — a read-only inspector for the live world: every entity, its tags, and each
// component's real-time field values. Pure reflection (no ECS systems). Draggable, resizable,
// size-contained with inner scrolling, layout persisted to localStorage.

import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import type { ComponentType, EntityId, World } from '../../types.js';
import { defaultDescriber, type EntityDescriber } from '../describer.js';
import { formatComponentData } from '../format.js';
import type { LifecycleRecorder } from '../recorder.js';
import { EntityTimeline, type TimelineLegendItem } from './EntityTimeline.js';
import { injectDevtoolsStyles } from './styles.js';

/** A consumer-provided tab, appended after the built-in entities/timeline tabs. */
export interface InspectorTab {
	id: string;
	label: string;
	render: () => ReactNode;
}

export interface EcsInspectorProps {
	world: World;
	/** When provided, a "timeline" tab renders the lifecycle waterfall. */
	recorder?: LifecycleRecorder;
	/** Drives entity-row labels (and the timeline's live rows). */
	describer?: EntityDescriber;
	/** Passed through to the timeline tab. */
	legend?: TimelineLegendItem[];
	/** Extra header text, appended after "N entities · tick T". */
	summary?: (world: World) => string;
	/** Extra tabs after the built-ins. */
	tabs?: InspectorTab[];
	/** localStorage key for layout persistence. */
	storageKey?: string;
	/** Initial open/collapsed state when nothing is persisted. */
	defaultOpen?: boolean;
}

// === layout persistence (so the inspector remembers where you put it) ===

type Layout = { x?: number; y?: number; w?: number; h?: number; open?: boolean; tab?: string };

function loadLayout(key: string): Layout {
	try {
		return JSON.parse(localStorage.getItem(key) || '{}') as Layout;
	} catch {
		return {};
	}
}
function saveLayout(key: string, patch: Layout): void {
	try {
		localStorage.setItem(key, JSON.stringify({ ...loadLayout(key), ...patch }));
	} catch {
		/* private mode / quota — non-fatal for a dev tool */
	}
}

const MARGIN = 8;
const KEEP = 90; // px of the window that must stay on screen so it's always grabbable
function clampPos(x: number, y: number, w: number): { x: number; y: number } {
	const maxX = window.innerWidth - KEEP;
	const minX = Math.min(MARGIN, MARGIN - (w - KEEP)); // allow sliding partly off the left
	const maxY = window.innerHeight - 34; // keep the header bar reachable
	return {
		x: Math.min(Math.max(x, minX), maxX),
		y: Math.min(Math.max(y, MARGIN), maxY),
	};
}

// === rows ===

function ComponentRow({ world, e, type }: { world: World; e: EntityId; type: ComponentType }) {
	return (
		<div className="recs-comp">
			<span className="recs-cname">{type.name}</span>
			<span className="recs-cval">{formatComponentData(world.getComponent(e, type))}</span>
		</div>
	);
}

function EntityRow({
	world,
	e,
	describer,
	open,
	onToggle,
}: {
	world: World;
	e: EntityId;
	describer: EntityDescriber;
	open: boolean;
	onToggle: () => void;
}) {
	const comps = world.getComponentsOf(e);
	const tags = world.getTagsOf(e);
	// identity off composition — the SAME describer the timeline renders from
	const { label, detail } = describer(world, e);
	return (
		<div className="recs-entity">
			<button type="button" className="recs-erow" onClick={onToggle}>
				<span className="recs-chevron">{open ? '▾' : '▸'}</span>
				<span className="recs-id">#{e}</span>
				<span className="recs-label">
					{label}
					{detail ? ` · ${detail}` : ''}
				</span>
				{tags.map((t) => (
					<span key={t.name} className="recs-tag">
						{t.name}
					</span>
				))}
				<span className="recs-count">{comps.length} comp</span>
			</button>
			{open && comps.map((c) => <ComponentRow key={c.name} world={world} e={e} type={c} />)}
		</div>
	);
}

// === the window ===

export function EcsInspector({
	world,
	recorder,
	describer = defaultDescriber,
	legend,
	summary,
	tabs,
	storageKey = 'reactive-ecs:inspector',
	defaultOpen = true,
}: EcsInspectorProps) {
	const winRef = useRef<HTMLDivElement>(null);
	const [, setTick] = useState(0);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const [open, setOpen] = useState<boolean>(() => loadLayout(storageKey).open ?? defaultOpen);
	const [tab, setTab] = useState<string>(() => loadLayout(storageKey).tab ?? 'entities');
	const [dragging, setDragging] = useState(false);
	const [collapsed, setCollapsed] = useState<Set<EntityId>>(() => new Set());
	const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
	const openRef = useRef(open);
	openRef.current = open;

	useEffect(() => {
		injectDevtoolsStyles();
	}, []);

	// live refresh of component values (~16 Hz). State + layout are untouched by this.
	useEffect(() => {
		const id = window.setInterval(() => setTick((n) => n + 1), 60);
		return () => window.clearInterval(id);
	}, []);

	// place the window: restore saved position/size, else dock to the top-right.
	useLayoutEffect(() => {
		const el = winRef.current;
		if (!el) return;
		const l = loadLayout(storageKey);
		if (typeof l.w === 'number') el.style.width = `${l.w}px`;
		if (typeof l.h === 'number') el.style.height = `${l.h}px`;
		const w = el.offsetWidth;
		const x = typeof l.x === 'number' ? l.x : window.innerWidth - w - 16;
		const y = typeof l.y === 'number' ? l.y : 16;
		setPos(clampPos(x, y, w));
	}, [storageKey]);

	// keep it on screen when the viewport changes; persist size when the user resizes it.
	useEffect(() => {
		const el = winRef.current;
		if (!el) return;
		const onResize = () => setPos((p) => (p ? clampPos(p.x, p.y, el.offsetWidth) : p));
		window.addEventListener('resize', onResize);
		const ro = new ResizeObserver(() => {
			if (openRef.current) saveLayout(storageKey, { w: el.offsetWidth, h: el.offsetHeight });
		});
		ro.observe(el);
		return () => {
			window.removeEventListener('resize', onResize);
			ro.disconnect();
		};
	}, [storageKey]);

	const onPointerDown = (e: ReactPointerEvent) => {
		if ((e.target as HTMLElement).closest('[data-nodrag]')) return; // let buttons be buttons
		const el = winRef.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
		e.currentTarget.setPointerCapture(e.pointerId);
		setDragging(true);
		e.preventDefault();
	};
	const onPointerMove = (e: ReactPointerEvent) => {
		const d = drag.current;
		const el = winRef.current;
		if (!d || d.id !== e.pointerId || !el) return;
		setPos(clampPos(d.ox + (e.clientX - d.sx), d.oy + (e.clientY - d.sy), el.offsetWidth));
	};
	const endDrag = (e: ReactPointerEvent) => {
		if (!drag.current || drag.current.id !== e.pointerId) return;
		drag.current = null;
		setDragging(false);
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
		const r = winRef.current?.getBoundingClientRect();
		if (r) saveLayout(storageKey, { x: r.left, y: r.top });
	};

	const toggleOpen = () => {
		setOpen((o) => {
			saveLayout(storageKey, { open: !o });
			return !o;
		});
	};
	const selectTab = (t: string) => {
		setTab(t);
		saveLayout(storageKey, { tab: t });
	};
	const toggleEntity = (e: EntityId) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(e)) next.delete(e);
			else next.add(e);
			return next;
		});

	const customTabs = tabs ?? [];
	// a persisted tab may no longer exist (recorder removed, custom tab renamed) — fall back
	const validTab =
		tab === 'entities' || (tab === 'timeline' && recorder) || customTabs.some((t) => t.id === tab)
			? tab
			: 'entities';
	const activeCustom = customTabs.find((t) => t.id === validTab);

	const entities = [...world.getAllEntities()].sort((a, b) => a - b);
	const className = `recs-inspector${open ? '' : ' collapsed'}${dragging ? ' dragging' : ''}`;

	return (
		<div
			ref={winRef}
			className={className}
			style={{ left: pos?.x ?? 16, top: pos?.y ?? 16, visibility: pos ? 'visible' : 'hidden' }}
		>
			<div
				className="recs-head"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				<span className="recs-grip" aria-hidden="true">
					⠿
				</span>
				<span className="recs-live" aria-hidden="true" />
				<span className="recs-name">ECS Inspector</span>
				<span className="recs-summary">
					{entities.length} entities · tick {world.currentTick}
					{summary ? ` · ${summary(world)}` : ''}
				</span>
				<button
					type="button"
					data-nodrag
					className="recs-btn recs-spacer"
					onClick={toggleOpen}
					title={open ? 'Collapse' : 'Expand'}
				>
					{open ? '▾' : '▸'}
				</button>
			</div>
			{open && (
				<div className="recs-tabs" data-nodrag>
					<button
						type="button"
						className={`recs-tab${validTab === 'entities' ? ' active' : ''}`}
						onClick={() => selectTab('entities')}
					>
						entities
					</button>
					{recorder && (
						<button
							type="button"
							className={`recs-tab${validTab === 'timeline' ? ' active' : ''}`}
							onClick={() => selectTab('timeline')}
						>
							timeline
						</button>
					)}
					{customTabs.map((t) => (
						<button
							key={t.id}
							type="button"
							className={`recs-tab${validTab === t.id ? ' active' : ''}`}
							onClick={() => selectTab(t.id)}
						>
							{t.label}
						</button>
					))}
				</div>
			)}
			{open && validTab === 'entities' && (
				<div className="recs-scroll">
					{entities.length === 0 ? (
						<div className="recs-empty">no entities</div>
					) : (
						entities.map((e) => (
							<EntityRow
								key={e}
								world={world}
								e={e}
								describer={describer}
								open={!collapsed.has(e)}
								onToggle={() => toggleEntity(e)}
							/>
						))
					)}
				</div>
			)}
			{open && validTab === 'timeline' && recorder && (
				<EntityTimeline world={world} recorder={recorder} describer={describer} legend={legend} />
			)}
			{open && activeCustom && <div className="recs-scroll">{activeCustom.render()}</div>}
		</div>
	);
}
