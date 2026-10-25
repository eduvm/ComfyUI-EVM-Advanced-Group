import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/**
 * EVM Group (Set/Get Edition)
 * Container de grupo avançado para ComfyUI com:
 * - Sistema de cores padrão do ComfyUI (LGraphCanvas.node_colors, cor única com transparência nativa).
 * - Painéis laterais dinâmicos de GetNode (esquerda) e SetNode (direita) que redimensionam
 *   automaticamente para o GetNode/SetNode mais largo (respeitando estado maximizado/minimizado).
 * - Reflow automático ao minimizar/maximizar (collapse) qualquer node dentro dos painéis ou do grupo.
 * - Geometria canônica na grade do ComfyUI (GRID = 10px, margens e gaps de 3 quadradinhos = 30px,
 *   NODE_VGAP = 60px contabilizando os 30px da barra de título do node e a tag #ID/tempo acima dele).
 */

// ── Constantes e Parâmetros Configuráveis via Settings do ComfyUI (⚡ EVM Group) ─
const GRID = 10;                 // 1 quadradinho do grid do ComfyUI = 10px
const NODE_TITLE_H = 30;         // 3 quadradinhos = 30px (altura da barra de título nativa do LiteGraph acima de pos[1])
const HEADER_H = 30;             // 3 quadradinhos = 30px (altura da barra de título do EVM Group)
const SUB_HEADER_H = 30;         // 3 quadradinhos = 30px (altura da faixa dos botões + Add GetNode / + Add SetNode)
const MIN_GROUP_H = 150;         // Altura mínima total do grupo
const HANDLE_SIZE = 18;          // Canto de redimensionamento

// Parâmetros dinâmicos controlados pelas Configurações do ComfyUI (com defaults de 3 quadradinhos = 30px)
let PAD = 30;                    // Margem interna do grupo (padrão: 3 quadradinhos = 30px)
let NODE_VGAP = 60;              // Gap vertical visível (30px) + NODE_TITLE_H (30px) = 60px
let NODE_HGAP = 30;              // Gap horizontal entre sub-colunas (padrão: 3 quadradinhos = 30px)
let COL_THRESHOLD = 100;         // Limiar X para agrupar nós na mesma coluna vertical
let MIN_RAIL_INNER_W = 140;      // Largura interna mínima de um painel lateral vazio
let DEFAULT_RAIL_W = MIN_RAIL_INNER_W + PAD * 2; // 200px (140 + 30 esq + 30 dir)
let MIN_CENTER_W = 140;          // Largura mínima da área central

// ── Sistema de Cores Padrão do ComfyUI (LGraphCanvas.node_colors) ───────────
let DEFAULT_GROUP_COLOR = "#3f789e"; // pale_blue padrão de grupos do ComfyUI
const RUN_GREEN = "#22c55e";
const SELECT_BORDER_COLOR = "#38bdf8";
let DEF_TITLE_ALPHA = 0.78;
let DEF_BODY_ALPHA = 0.22;
let DEF_FONT_SIZE = 16;

// Estado reativo das configurações extras do EVM Group
const EVM_CFG = {
    autoReflow: true,
    pushNeighborsOnExpand: true,
    snapToGrid: true,
    defaultLeftOpen: true,
    defaultRightOpen: true,
    autoNamingFormat: "<Grupo>_<TIPO>", // "<Grupo>_<TIPO>" | "<TIPO>_<Grupo>" | "Desativado"
    syncRenameOnGroupTitle: true,
    headerBtnVis: "always",             // "always" | "compact" | "hover"
    showLinksWhenFolded: true,
    showFloatingToolbar: true,
    showConvertInNativeToolbox: true,
};

function recalcDerivedGeometry() {
    DEFAULT_RAIL_W = MIN_RAIL_INNER_W + PAD * 2;
}

function refreshAllGroupsLayout() {
    try {
        const gr = curGraph();
        if (!gr) return;
        for (const g of ensureEvmGroups(gr)) {
            g._lastLayoutSig = "";
            if (!g.folded) {
                const cNodes = getCentralMemberNodes(g, gr);
                if (cNodes.length) tidyGroupCentralNodes(g, gr, cNodes);
                else layoutDockedNodes(g, gr, { shrinkHeightToFit: true });
            }
        }
        repaint();
    } catch (_e) {}
}

// Cores legadas da v1 (amarelo/azul/verde) que devem migrar automaticamente para o padrão ComfyUI
const LEGACY_V1_COLORS = new Set(["#eab308", "#1e3a8a", "#15803d"]);

let _idc = 0;
function newEvmGroupId() {
    return "evmg_" + Date.now().toString(36) + "_" + (_idc++) + "_" + Math.random().toString(36).slice(2, 6);
}

function isVueNodes() {
    return !!(window.LiteGraph && window.LiteGraph.vueNodesMode);
}

function curGraph() {
    return app.canvas?.graph || app.graph;
}

function ensureEvmGroups(graph) {
    const g = graph || curGraph();
    if (!g) return [];
    if (!g.extra) g.extra = {};
    if (!Array.isArray(g.extra.evmGroups)) g.extra.evmGroups = [];
    for (const grp of g.extra.evmGroups) migrateLegacyColorsIfNeeded(grp);
    return g.extra.evmGroups;
}

// ── Funções de Grade (Snap 10px) ────────────────────────────────────────────
function snap(v) {
    if (!EVM_CFG.snapToGrid) return Math.round(v);
    return Math.round(v / GRID) * GRID;
}

function snapUp(v) {
    if (!EVM_CFG.snapToGrid) return Math.ceil(v);
    return Math.ceil(v / GRID) * GRID;
}

// ── Utilitários de Cor (Suporte a Hex de 3 e 6 dígitos do ComfyUI) ──────────
function normalizeHex(hex) {
    if (!hex || typeof hex !== "string") return DEFAULT_GROUP_COLOR;
    const s = hex.trim();
    const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m6) return "#" + m6[1].toLowerCase();
    const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
    if (m3) {
        const c = m3[1].toLowerCase();
        return "#" + c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    }
    return DEFAULT_GROUP_COLOR;
}

function hexToRgb(hex) {
    const norm = normalizeHex(hex).slice(1);
    const n = parseInt(norm, 16);
    if (Number.isNaN(n)) return { r: 63, g: 120, b: 158 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c.r},${c.g},${c.b},${a})`;
}

function contrastInk(hex) {
    const c = hexToRgb(hex);
    const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return lum > 0.62 ? "#111827" : "#ffffff";
}

function migrateLegacyColorsIfNeeded(g) {
    if (!g || g._colorMigratedV2) return;
    if (
        LEGACY_V1_COLORS.has(String(g.titleColor || "").toLowerCase()) &&
        LEGACY_V1_COLORS.has(String(g.bodyColor || "").toLowerCase())
    ) {
        g.color = DEFAULT_GROUP_COLOR;
        delete g.titleColor;
        delete g.bodyColor;
        delete g.railColor;
        delete g.titleAlpha;
        delete g.bodyAlpha;
        delete g.railAlpha;
    } else if (!g.color) {
        g.color = normalizeHex(g.titleColor || g.bodyColor || DEFAULT_GROUP_COLOR);
    }
    g._colorMigratedV2 = true;
}

/**
 * Retorna a paleta padrão de cores de grupos/nós do ComfyUI (LGraphCanvas.node_colors).
 */
function getComfyStandardGroupColors() {
    const raw = window.LGraphCanvas?.node_colors || window.LiteGraph?.LGraphCanvas?.node_colors || {
        red:       { color: "#322", bgcolor: "#533", groupcolor: "#A88" },
        brown:     { color: "#332922", bgcolor: "#593930", groupcolor: "#b06634" },
        green:     { color: "#232", bgcolor: "#353", groupcolor: "#8A8" },
        blue:      { color: "#223", bgcolor: "#335", groupcolor: "#88A" },
        pale_blue: { color: "#2a363b", bgcolor: "#3f5159", groupcolor: "#3f789e" },
        cyan:      { color: "#233", bgcolor: "#355", groupcolor: "#8AA" },
        purple:    { color: "#323", bgcolor: "#535", groupcolor: "#a1309b" },
        yellow:    { color: "#432", bgcolor: "#653", groupcolor: "#b58b2a" },
        black:     { color: "#222", bgcolor: "#000", groupcolor: "#444" },
    };
    const out = [];
    for (const [name, obj] of Object.entries(raw)) {
        if (!obj) continue;
        const gc = normalizeHex(obj.groupcolor || obj.bgcolor || obj.color || DEFAULT_GROUP_COLOR);
        const swatch = normalizeHex(obj.bgcolor || obj.groupcolor || gc);
        out.push({
            name,
            label: name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
            groupcolor: gc,
            swatch,
        });
    }
    return out;
}

function gGroupColor(g) {
    migrateLegacyColorsIfNeeded(g);
    return normalizeHex(g.color || g.titleColor || g.bodyColor || DEFAULT_GROUP_COLOR);
}

function gTitleColor(g) {
    migrateLegacyColorsIfNeeded(g);
    return normalizeHex(g.color || g.titleColor || DEFAULT_GROUP_COLOR);
}

function gBodyColor(g) {
    migrateLegacyColorsIfNeeded(g);
    return normalizeHex(g.color || g.bodyColor || DEFAULT_GROUP_COLOR);
}

function setEvmGroupColor(g, hexOrNull) {
    if (!g) return;
    const isReset = hexOrNull === null || hexOrNull === undefined || hexOrNull === "";
    const c = !isReset ? normalizeHex(hexOrNull) : DEFAULT_GROUP_COLOR;
    const targets = _selectedIds.has(g.id) ? getSelectedEvmGroups() : [g];
    for (const t of targets) {
        t.color = c;
        t.titleColor = c;
        t.bodyColor = c;
        delete t.railColor;
        t._colorMigratedV2 = true;
    }
    markChanged();
}

function gTitleAlpha(g) { return Number.isFinite(g.titleAlpha) ? g.titleAlpha : DEF_TITLE_ALPHA; }
function gBodyAlpha(g)  { return Number.isFinite(g.bodyAlpha)  ? g.bodyAlpha  : DEF_BODY_ALPHA; }
function gFontSize(g)   { return Number.isFinite(g.fontSize)   ? g.fontSize   : DEF_FONT_SIZE; }
function headerH(_g)    { return HEADER_H; } // Sempre 30px (3 quadradinhos) para alinhar com o grid do ComfyUI

function leftRailW(g) {
    if (g.folded || g.leftRailOpen === false) return 0;
    return Number.isFinite(g.leftRailW) ? Math.max(DEFAULT_RAIL_W, snapUp(g.leftRailW)) : DEFAULT_RAIL_W;
}

function rightRailW(g) {
    if (g.folded || g.rightRailOpen === false) return 0;
    return Number.isFinite(g.rightRailW) ? Math.max(DEFAULT_RAIL_W, snapUp(g.rightRailW)) : DEFAULT_RAIL_W;
}

function minGroupWidth(g) {
    return leftRailW(g) + MIN_CENTER_W + rightRailW(g);
}

function screenToGraph(clientX, clientY) {
    const c = app.canvas;
    const el = c?.canvas, ds = c?.ds;
    if (!el || !ds) return null;
    const r = el.getBoundingClientRect();
    const scale = ds.scale || 1, off = ds.offset || [0, 0];
    return [(clientX - r.left) / scale - off[0], (clientY - r.top) / scale - off[1]];
}

// ── Regra Inviolável: Sincronização Dupla de Widgets (widgets_values + widgets_values_named) ──
function syncWidgetValue(node, widgetIndex, widgetName, newValue) {
    if (!node) return;
    if (node.widgets && node.widgets[widgetIndex]) {
        node.widgets[widgetIndex].value = newValue;
    }
    if (!Array.isArray(node.widgets_values)) {
        node.widgets_values = [];
    }
    node.widgets_values[widgetIndex] = newValue;
    if (node.widgets_values_named && typeof node.widgets_values_named === "object") {
        const key = widgetName || node.widgets?.[widgetIndex]?.name || "Constant";
        node.widgets_values_named[key] = newValue;
    }
}

function sanitizeGroupPrefix(title) {
    const clean = String(title || "Group")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_\-\u00C0-\u017F]/g, "");
    return clean || "Group";
}

// ── Ícones Vetoriais (Path2D — Zero custo de GPU readback no canvas) ────────
const ICON_PATHS = {
    play:   { w: 64, h: 64, d: "M56.655,35.769L13.607,59.804c-3.485,1.946-8.039-.16-8.442-4.131-.021-.205-.031-.412-.031-.622V8.95c0-.21.011-.418.031-.622.403-3.971,4.958-6.077,8.442-4.131l43.048,24.034c2.95,1.647,2.95,5.892,0,7.539Z" },
    mute:   { w: 23.295, h: 23.295, d: "M11.647,0C5.225,0,0,5.225,0,11.647s5.225,11.648,11.647,11.648,11.647-5.226,11.647-11.648S18.07,0,11.647,0ZM11.647,4c1.359,0,2.634.36,3.741.985L4.985,15.389c-.624-1.107-.985-2.382-.985-3.742,0-4.217,3.431-7.647,7.647-7.647ZM11.647,19.295c-1.408,0-2.724-.389-3.858-1.055l10.45-10.45c.666,1.134,1.055,2.45,1.055,3.857,0,4.217-3.431,7.648-7.647,7.648Z" },
    bypass: { w: 23.16, h: 21.297, d: "M17.3,15.407v-1.891c0-.3-.243-.543-.543-.543H1.192c-.658,0-1.192-.533-1.192-1.192v-2.298c0-.658.533-1.192,1.192-1.192h15.566c.3,0,.543-.243.543-.543v-1.891c0-.484.585-.726.926-.384l4.774,4.774c.212.212.212.556,0,.768l-4.774,4.774c-.342.342-.926.1-.926-.384ZM14.5,0H3.009c-.3,0-.543.243-.543.543v4.926c0,.3.243.543.543.543h11.492c.3,0,.543-.243.543-.543V.543c0-.3-.243-.543-.543-.543ZM3.009,21.297h11.492c.3,0,.543-.243.543-.543v-4.959c0-.3-.243-.543-.543-.543H3.009c-.3,0-.543.243-.543.543v4.959c0,.3.243.543.543.543Z" },
    fold:   { w: 59.763, h: 63.302, d: "M53.415,56.13c1.647,2.95-.136,6.803-3.497,7.146-.174.018-.349.026-.526.026H10.371c-.178,0-.354-.009-.526-.026-3.362-.335-5.144-4.197-3.497-7.146L26.691,19.693c1.394-2.497,4.987-2.497,6.381,0l20.343,36.437ZM55.2,0H4.563C2.043,0,0,2.043,0,4.563v5.378c0,2.52,2.043,4.563,4.563,4.563h50.637c2.52,0,4.563-2.043,4.563-4.563v-5.378c0-2.52-2.043-4.563-4.563-4.563Z" },
    unfold: { w: 62.258, h: 58.612, d: "M.801,9.242C-1.321,5.441.976.475,5.307.034c.224-.023.449-.034.678-.034h50.286c.229,0,.456.012.678.034,4.332.432,6.629,5.408,4.506,9.208l-26.216,46.956c-1.796,3.218-6.427,3.218-8.223,0L.801,9.242Z" },
};
const BTN_ICONS = { run: "play", mute: "mute", bypass: "bypass", fold: "fold", unfold: "unfold" };

function drawIcon(ctx, name, x, y, size, color) {
    const spec = ICON_PATHS[name];
    if (!spec) return;
    if (spec._p === undefined) {
        try { spec._p = typeof Path2D === "function" ? new Path2D(spec.d) : null; }
        catch (_e) { spec._p = null; }
    }
    if (!spec._p) return;
    const s = size / Math.max(spec.w, spec.h);
    ctx.save();
    ctx.translate(x + (size - spec.w * s) / 2, y + (size - spec.h * s) / 2);
    ctx.scale(s, s);
    ctx.fillStyle = color;
    ctx.fill(spec._p);
    ctx.restore();
}

// ── Estado Global de Seleção, Multi-Seleção (Marquee / Shift) e Execução ────
let _selectedId = null;
let _selectedIds = new Set();
let _hoverId = null;
let _hotBtn = null;
let _drag = null;
let _carry = null;
let _lmbDown = false;
let _clickDeselectPending = false;
let _pendingEvmSelect = null;
let _pendingBodyAdditiveToggle = null;
let _marqueeRect = null;
let _marqueeStartPt = null;
let _marqueeShift = false;
let _preMarqueeSelectedIds = null;
let _runningNodeId = null;
let _progress = null;

function repaint() {
    try { app.canvas?.setDirty(true, true); } catch (_e) {}
}

function markChanged() {
    try { app.graph?.change?.(); } catch (_e) {}
    repaint();
}

function clearNativeAndPixSelection() {
    const c = app.canvas;
    if (!c) return;
    try { if (typeof c.deselectAllNodes === "function") c.deselectAllNodes(); } catch (_e) {}
    try { if (c.selectedItems && typeof c.deselect === "function") for (const it of [...c.selectedItems]) c.deselect(it); } catch (_e) {}
    try { if (c.selectedItems && c.selectedItems.clear) c.selectedItems.clear(); } catch (_e) {}
    try { if (c.selected_nodes) for (const k of Object.keys(c.selected_nodes)) delete c.selected_nodes[k]; } catch (_e) {}
    try { c.selected_group = null; } catch (_e) {}
}

function selectEvmGroup(g) {
    if (!g) {
        _selectedId = null;
        _selectedIds.clear();
        repaint();
        return;
    }
    _selectedId = g.id;
    _selectedIds = new Set([g.id]);
    clearNativeAndPixSelection();
    repaint();
}

/**
 * Alterna (adiciona/remove) um EVM Group na multi-seleção (Shift/Ctrl-click)
 * SEM limpar os nodes nativos ou outros EVM Groups já selecionados.
 */
function toggleEvmGroupSelection(g) {
    if (!g) return;
    if (_selectedIds.has(g.id)) {
        _selectedIds.delete(g.id);
        if (_selectedId === g.id) {
            _selectedId = _selectedIds.size ? [..._selectedIds][_selectedIds.size - 1] : null;
        }
    } else {
        _selectedIds.add(g.id);
        _selectedId = g.id;
    }
    repaint();
}

function getSelectedEvmGroup() {
    if (!_selectedId) return null;
    return ensureEvmGroups().find(g => g.id === _selectedId) || null;
}

function getSelectedEvmGroups() {
    const gs = ensureEvmGroups();
    return [..._selectedIds].map(id => gs.find(g => g.id === id)).filter(Boolean);
}

// ── Medição Precisa de Largura e Altura de Nodes (Maximizado vs Minimizado) ──
let _measCtx = null;
function getMeasCtx() {
    if (!_measCtx) _measCtx = document.createElement("canvas").getContext("2d");
    return _measCtx;
}

/**
 * Mede a largura necessária para o texto da barra de título de um nó no LiteGraph.
 */
function measureNodeTitleRequiredWidth(node) {
    const ctx = getMeasCtx();
    ctx.font = node?.titleFontStyle || "bold 14px Arial, sans-serif";
    const title = String((typeof node?.getTitle === "function" ? node.getTitle() : node?.title) || node?.type || "");
    const textW = ctx.measureText(title).width;
    // LiteGraph usa: a[0] - NODE_TITLE_HEIGHT * 2 (60px) para o texto do título
    return Math.ceil(textW + NODE_TITLE_H * 2 + 12);
}

/**
 * Mede a largura necessária para um SetNode/GetNode quando maximizado (expandido),
 * garantindo que tanto o título quanto o widget "Constant" + valor caibam sem "...".
 */
function computeSetGetExpandedRequiredWidth(node) {
    const ctx = getMeasCtx();
    const titleReqW = measureNodeTitleRequiredWidth(node);

    ctx.font = "14px Arial, sans-serif";
    const widgetVal = String(node?.widgets?.[0]?.value || "");
    const widgetName = String(node?.widgets?.[0]?.name || "Constant");
    const valW = ctx.measureText(widgetVal).width;
    const nameW = ctx.measureText(widgetName).width;
    // No LiteGraph, o widget desenha o label à esquerda, valor à direita e setas/margens (~70px)
    const widgetReqW = Math.ceil(nameW + valW + 76);

    let compW = 140;
    try {
        if (typeof node?.computeSize === "function") {
            const cs = node.computeSize();
            if (Array.isArray(cs) && Number.isFinite(cs[0])) compW = cs[0];
        }
    } catch (_e) {}

    return snapUp(Math.max(titleReqW, widgetReqW, compW, MIN_RAIL_INNER_W));
}

/**
 * Mede a largura visual de um nó quando minimizado (collapsed = true) no LiteGraph.
 */
function computeNodeCollapsedWidth(node) {
    const ctx = getMeasCtx();
    ctx.font = "bold 14px Arial, sans-serif";
    const fullTitle = String((typeof node?.getTitle === "function" ? node.getTitle() : node?.title) || node?.type || "");
    // Usa sempre "bold 14px Arial" (mesma métrica de measureNodeTitleRequiredWidth e wf_common.py)
    // em vez de node.innerFontStyle ("normal 12px Arial") para evitar divergência de largura nos trilhos
    const measuredFull = Math.ceil(ctx.measureText(fullTitle).width + NODE_TITLE_H * 2);
    const lgCollapsed = Number.isFinite(node?._collapsed_width) && node._collapsed_width > 0
        ? node._collapsed_width
        : measuredFull;
    return snapUp(Math.max(lgCollapsed, measuredFull, MIN_RAIL_INNER_W));
}

/**
 * Retorna a largura visual ativa de um SetNode/GetNode ancorado, respeitando
 * se ele está minimizado (collapsed) ou maximizado (expandido).
 */
function getDockedNodeActiveWidth(node) {
    if (!node) return MIN_RAIL_INNER_W;
    if (node.flags?.collapsed) {
        return computeNodeCollapsedWidth(node);
    }

    const expandedReqW = computeSetGetExpandedRequiredWidth(node);
    // Ajusta automaticamente a largura mínima quando o texto do Set/Get muda (e está expandido),
    // mas permite redimensionamento horizontal manual sem travar o tamanho anterior.
    if (node.size && node._evmLastReqW !== expandedReqW) {
        if (!node.size[0] || node.size[0] < expandedReqW || node.size[0] === node._evmLastReqW) {
            node.size[0] = expandedReqW;
        }
        node._evmLastReqW = expandedReqW;
    }

    const userW = node.size?.[0] || expandedReqW;
    return snapUp(Math.max(userW, expandedReqW, MIN_RAIL_INNER_W));
}

function getNodeActiveBodyHeight(node) {
    if (!node || node.flags?.collapsed) return 0;
    let h = node.size?.[1] || 60;
    if (node.type === "SetNode" || node.type === "GetNode") {
        let compH = 60;
        try {
            const cs = node.computeSize?.();
            if (Array.isArray(cs) && Number.isFinite(cs[1])) compH = cs[1];
        } catch (_e) {}
        h = Math.max(h, compH);
    }
    return snapUp(h);
}

function nodeVisualBounds(n) {
    const collapsed = !!n.flags?.collapsed;
    const w = collapsed
        ? computeNodeCollapsedWidth(n)
        : snapUp(n.renderingSize?.[0] || n.size?.[0] || 140);
    const bodyH = collapsed ? 0 : snapUp(n.renderingSize?.[1] || n.size?.[1] || 30);
    return { x: n.pos[0], y: n.pos[1] - NODE_TITLE_H, w, h: bodyH + NODE_TITLE_H };
}

function setNodePos(node, x, y) {
    const sx = snap(x);
    const sy = snap(y);
    if (isVueNodes()) {
        node.pos = [sx, sy];
    } else if (node.pos) {
        node.pos[0] = sx;
        node.pos[1] = sy;
    } else {
        node.pos = [sx, sy];
    }
}

// ── Geometria de Contenção e Z-Order ────────────────────────────────────────
function inRect(g, p) {
    return p[0] >= g.x && p[0] <= g.x + g.w && p[1] >= g.y && p[1] <= g.y + g.h;
}

function inHeader(g, p) {
    return p[0] >= g.x && p[0] <= g.x + g.w && p[1] >= g.y && p[1] <= g.y + HEADER_H;
}

function inSubHeader(g, p) {
    if (g.folded) return false;
    return p[0] >= g.x && p[0] <= g.x + g.w && p[1] >= g.y + HEADER_H && p[1] <= g.y + HEADER_H + SUB_HEADER_H;
}

function inRailArea(g, p) {
    if (g.folded) return false;
    if (p[1] < g.y + HEADER_H || p[1] > g.y + g.h) return false;
    const lW = leftRailW(g);
    const rW = rightRailW(g);
    if (lW > 0 && p[0] >= g.x && p[0] <= g.x + lW) return true;
    if (rW > 0 && p[0] >= g.x + g.w - rW && p[0] <= g.x + g.w) return true;
    return false;
}

function cornerAt(g, p) {
    if (g.folded || g.pinned) return null;
    if (!inRect(g, p)) return null;
    const L = p[0] <= g.x + HANDLE_SIZE, R = p[0] >= g.x + g.w - HANDLE_SIZE;
    const T = p[1] <= g.y + HANDLE_SIZE, B = p[1] >= g.y + g.h - HANDLE_SIZE;
    if (T && L) return "tl";
    if (T && R) return "tr";
    if (B && L) return "bl";
    if (B && R) return "br";
    return null;
}

function containsBox(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
           inner.x + inner.w <= outer.x + outer.w &&
           inner.y + inner.h <= outer.y + outer.h;
}

function orderedEvmGroups() {
    const gs = ensureEvmGroups();
    if (gs.length < 2) return gs;
    const rows = gs.map((g, i) => {
        let d = 0;
        for (const o of gs) if (o !== g && containsBox(o, g)) d++;
        return { g, i, d };
    });
    rows.sort((a, b) => (a.d - b.d) || (a.i - b.i));
    return rows.map(r => r.g);
}

function evmGroupAt(p) {
    if (!p) return null;
    const gs = orderedEvmGroups();
    for (let i = gs.length - 1; i >= 0; i--) {
        if (!isHiddenGroup(gs[i]) && inRect(gs[i], p)) return gs[i];
    }
    return null;
}

// ── Gerenciamento de GetNodes e SetNodes Ancorados (Docked) ─────────────────
function ensureDockArrays(g) {
    if (!Array.isArray(g.getNodeIds)) g.getNodeIds = [];
    if (!Array.isArray(g.setNodeIds)) g.setNodeIds = [];
    if (g.leftRailOpen === undefined) g.leftRailOpen = true;
    if (g.rightRailOpen === undefined) g.rightRailOpen = true;
    if (!Number.isFinite(g.leftRailW)) g.leftRailW = DEFAULT_RAIL_W;
    if (!Number.isFinite(g.rightRailW)) g.rightRailW = DEFAULT_RAIL_W;
}

function resolveNodeList(graph, idList) {
    if (!graph || !Array.isArray(idList)) return [];
    const nodes = [];
    const validIds = [];
    for (const rawId of idList) {
        const n = graph.getNodeById(Number(rawId)) || graph.getNodeById(rawId);
        if (n) {
            nodes.push(n);
            validIds.push(n.id);
        }
    }
    if (validIds.length !== idList.length) {
        idList.splice(0, idList.length, ...validIds);
    }
    return nodes;
}

function findOwnerGroupForDockedNode(node) {
    if (!node) return null;
    const nid = String(node.id);
    for (const g of ensureEvmGroups(node.graph)) {
        ensureDockArrays(g);
        if (g.getNodeIds.some(id => String(id) === nid)) return { group: g, side: "left" };
        if (g.setNodeIds.some(id => String(id) === nid)) return { group: g, side: "right" };
    }
    return null;
}

let _evmConfiguring = false;
function isGraphConfiguring(graph) {
    return !!(
        _evmConfiguring ||
        app.configuringGraph ||
        graph?._evmConfiguring ||
        curGraph()?._evmConfiguring
    );
}

/**
 * Retorna apenas os nós centrais (custom nodes normais) contidos dentro do grupo,
 * excluindo os GetNodes e SetNodes ancorados nos trilhos laterais.
 */
function getCentralMemberNodes(g, graph) {
    const gr = graph || curGraph();
    if (!gr || !g || g.folded) return [];
    ensureDockArrays(g);
    const allGroups = ensureEvmGroups(gr);
    const validGroupIds = new Set(allGroups.filter(Boolean).map(og => og.id));
    const allDockedSet = new Set();
    for (const og of allGroups) {
        if (!og) continue;
        ensureDockArrays(og);
        for (const id of og.getNodeIds) allDockedSet.add(String(id));
        for (const id of og.setNodeIds) allDockedSet.add(String(id));
    }
    const isResizingGroup = (_drag?.mode === "resize" && _drag?.g === g);
    const out = [];
    for (const n of (gr._nodes || [])) {
        if (!n || !n.pos) continue;
        if (allDockedSet.has(String(n.id))) continue;
        if (!isResizingGroup && n._evmLastGroupId && validGroupIds.has(n._evmLastGroupId)) {
            if (n._evmLastGroupId === g.id) {
                out.push(n);
            }
            continue;
        }
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const centerInGroup = (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h);
        if (centerInGroup) {
            n._evmLastGroupId = g.id;
            out.push(n);
        } else if (isResizingGroup && n._evmLastGroupId === g.id) {
            delete n._evmLastGroupId;
        }
    }
    return out;
}

/**
 * Agrupa uma lista de nós em sub-colunas verticais (usando COL_THRESHOLD = 100px),
 * ordenadas da esquerda para a direita, e de cima para baixo dentro de cada coluna.
 */
function clusterIntoSubColumns(nodes) {
    if (!nodes.length) return [];
    const resizingNode = app.canvas?.resizing_node;
    const effX = (n) => (n === resizingNode && Number.isFinite(n?._evmAlignedX)) ? n._evmAlignedX : n.pos[0];
    const effY = (n) => (n === resizingNode && Number.isFinite(n?._evmAlignedY)) ? n._evmAlignedY : n.pos[1];

    const sortedX = [...nodes].sort((a, b) => (effX(a) - effX(b)) || (effY(a) - effY(b)));
    const subCols = [];
    for (const n of sortedX) {
        const nx = effX(n);
        let placed = false;
        for (const col of subCols) {
            if (Math.abs(nx - effX(col[0])) < COL_THRESHOLD) {
                col.push(n);
                placed = true;
                break;
            }
        }
        if (!placed) subCols.push([n]);
    }
    for (const col of subCols) {
        col.sort((a, b) => (effY(a) - effY(b)) || (a.id - b.id));
    }
    return subCols;
}

/**
 * Posiciona automaticamente todos os GetNodes no trilho esquerdo e SetNodes no trilho direito,
 * redimensionando automaticamente a largura de cada trilho para o GetNode/SetNode mais largo
 * (respeitando se os nós estão maximizados ou minimizados) e mantendo 3 quadradinhos (30px)
 * de margem e de espaçamento vertical entre os nós (NODE_VGAP = 60px).
 */
let _pushingNeighbors = false;

/**
 * Desloca um grupo (EVM Group, Pixaroma Group ou Grupo Nativo) e todos os seus nós
 * internos (incluindo GetNode/SetNode ancorados e nós dobrados) por (dx, dy).
 */
function shiftGroupDescriptorByDelta(desc, dx, dy, graph) {
    const gr = graph || curGraph();
    if (!gr || (!dx && !dy)) return;
    const g = desc.raw;
    const allNodes = gr._nodes || [];
    const byId = new Map();
    for (const n of allNodes) {
        if (n && n.id != null) byId.set(String(n.id), n);
    }

    if (desc.kind === "evmgroup") {
        const subGroups = containedEvmGroups(g);
        const nodesToMove = new Map();

        for (const n of groupMemberNodes(g)) {
            if (n && n.pos) nodesToMove.set(String(n.id), n);
        }
        // Se houver grupos aninhados ou nós dobrados, inclui também
        if (Array.isArray(g.foldNodes)) {
            for (const fid of g.foldNodes) {
                const fn = byId.get(String(fid));
                if (fn && fn.pos) nodesToMove.set(String(fn.id), fn);
            }
        }
        for (const sg of subGroups) {
            for (const n of groupMemberNodes(sg)) {
                if (n && n.pos) nodesToMove.set(String(n.id), n);
            }
            sg.x = snap(sg.x + dx);
            sg.y = snap(sg.y + dy);
        }

        g.x = snap(g.x + dx);
        g.y = snap(g.y + dy);
        desc.x = g.x;
        desc.y = g.y;

        for (const n of nodesToMove.values()) {
            setNodePos(n, n.pos[0] + dx, n.pos[1] + dy);
        }
    } else if (desc.kind === "pixgroup") {
        const members = [];
        for (const n of allNodes) {
            if (!n || !n.pos) continue;
            const b = nodeVisualBounds(n);
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            if (cx >= desc.x && cx <= desc.x + desc.w && cy >= desc.y && cy <= desc.y + desc.h) {
                members.push(n);
            }
        }
        g.x = snap(g.x + dx);
        g.y = snap(g.y + dy);
        desc.x = g.x;
        desc.y = g.y;
        for (const n of members) {
            setNodePos(n, n.pos[0] + dx, n.pos[1] + dy);
        }
    } else if (desc.kind === "nativegroup") {
        const pos = g._pos || g.pos;
        if (!pos) return;
        const members = [];
        for (const n of allNodes) {
            if (!n || !n.pos) continue;
            const b = nodeVisualBounds(n);
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            if (cx >= desc.x && cx <= desc.x + desc.w && cy >= desc.y && cy <= desc.y + desc.h) {
                members.push(n);
            }
        }
        pos[0] = snap(pos[0] + dx);
        pos[1] = snap(pos[1] + dy);
        desc.x = pos[0];
        desc.y = pos[1];
        for (const n of members) {
            setNodePos(n, n.pos[0] + dx, n.pos[1] + dy);
        }
    }
}

/**
 * Empurra automaticamente os grupos vizinhos (em cascata para a direita, esquerda e para baixo)
 * sempre que `sourceGroup` crescer de tamanho, evitando sobreposição e mantendo o vão canônico
 * de `PAD` (3 quadradinhos = 30px) entre grupos.
 */
function pushNeighborGroupsOnExpand(sourceGroup, prevBounds = null, graph = null) {
    if (!EVM_CFG.pushNeighborsOnExpand || !sourceGroup || _pushingNeighbors) return;
    const gr = graph || curGraph();
    if (!gr) return;

    const grewRight = !prevBounds || (sourceGroup.x + sourceGroup.w > prevBounds.x + prevBounds.w);
    const grewLeft  = !prevBounds || (sourceGroup.x < prevBounds.x);
    const grewDown  = !prevBounds || (sourceGroup.y + sourceGroup.h > prevBounds.y + prevBounds.h);
    const grewUp    = !prevBounds || (sourceGroup.y < prevBounds.y);
    if (!grewRight && !grewLeft && !grewDown && !grewUp) return;

    _pushingNeighbors = true;
    try {
        const groupGap = PAD; // 3 quadradinhos (30px por padrão)
        const descriptors = [];

        // 1. EVM Groups
        for (const eg of ensureEvmGroups(gr)) {
            if (!eg || eg === sourceGroup || isHiddenGroup(eg)) continue;
            if (containsBox(sourceGroup, eg) || containsBox(eg, sourceGroup)) continue;
            descriptors.push({ kind: "evmgroup", raw: eg, x: eg.x, y: eg.y, w: eg.w, h: eg.h });
        }
        // 2. Pixaroma Groups
        const pixArr = gr.extra?.pixaromaGroups;
        if (Array.isArray(pixArr)) {
            for (const pg of pixArr) {
                if (!pg) continue;
                descriptors.push({ kind: "pixgroup", raw: pg, x: pg.x, y: pg.y, w: pg.w, h: pg.h });
            }
        }
        // 3. Native ComfyUI Groups
        const natArr = gr._groups || gr.groups;
        if (Array.isArray(natArr)) {
            for (const ng of natArr) {
                if (!ng) continue;
                const pos = ng._pos || ng.pos;
                const size = ng._size || ng.size;
                if (pos && size) {
                    descriptors.push({ kind: "nativegroup", raw: ng, x: pos[0], y: pos[1], w: size[0], h: size[1] });
                }
            }
        }

        if (!descriptors.length) return;

        const refLeft  = prevBounds ? prevBounds.x : sourceGroup.x;
        const refRight = prevBounds ? (prevBounds.x + prevBounds.w) : (sourceGroup.x + sourceGroup.w);
        const refTop   = prevBounds ? prevBounds.y : sourceGroup.y;

        // A) Empuxo Lateral para a Direita (Cascata Esquerda -> Direita)
        if (grewRight) {
            const rightCands = descriptors
                .filter(d => d.x >= refLeft + 10)
                .sort((a, b) => a.x - b.x);
            const pushers = [{ x: sourceGroup.x, y: sourceGroup.y, w: sourceGroup.w, h: sourceGroup.h }];

            for (const cand of rightCands) {
                let targetX = cand.x;
                for (const p of pushers) {
                    const overlapsY = (cand.y < p.y + p.h) && (cand.y + cand.h > p.y);
                    if (overlapsY && cand.x >= p.x && cand.x < p.x + p.w + groupGap) {
                        const reqX = snap(p.x + p.w + groupGap);
                        if (reqX > targetX) targetX = reqX;
                    }
                }
                if (targetX > cand.x) {
                    shiftGroupDescriptorByDelta(cand, targetX - cand.x, 0, gr);
                    pushers.push(cand);
                }
            }
        }

        // B) Empuxo Lateral para a Esquerda (quando o trilho esquerdo abre/alarga ou canto esquerdo é esticado)
        if (grewLeft) {
            const leftCands = descriptors
                .filter(d => (d.x + d.w) <= refRight - 10 && d.x < sourceGroup.x)
                .sort((a, b) => (b.x + b.w) - (a.x + a.w));
            const pushers = [{ x: sourceGroup.x, y: sourceGroup.y, w: sourceGroup.w, h: sourceGroup.h }];

            for (const cand of leftCands) {
                let targetX = cand.x;
                for (const p of pushers) {
                    const overlapsY = (cand.y < p.y + p.h) && (cand.y + cand.h > p.y);
                    if (overlapsY && cand.x < p.x && (cand.x + cand.w) > p.x - groupGap) {
                        const reqX = snap(p.x - groupGap - cand.w);
                        if (reqX < targetX) targetX = reqX;
                    }
                }
                if (targetX < cand.x) {
                    shiftGroupDescriptorByDelta(cand, targetX - cand.x, 0, gr);
                    pushers.push(cand);
                }
            }
        }

        // C) Empuxo Vertical para Baixo (Cascata Topo -> Base para grupos na mesma coluna horizontal)
        if (grewDown) {
            const downCands = descriptors
                .filter(d => d.y >= refTop + 10)
                .sort((a, b) => a.y - b.y);
            const pushers = [{ x: sourceGroup.x, y: sourceGroup.y, w: sourceGroup.w, h: sourceGroup.h }];

            for (const cand of downCands) {
                let targetY = cand.y;
                for (const p of pushers) {
                    const overlapsX = (cand.x < p.x + p.w) && (cand.x + cand.w > p.x);
                    if (overlapsX && cand.y >= p.y && cand.y < p.y + p.h + groupGap) {
                        const reqY = snap(p.y + p.h + groupGap);
                        if (reqY > targetY) targetY = reqY;
                    }
                }
                if (targetY > cand.y) {
                    shiftGroupDescriptorByDelta(cand, 0, targetY - cand.y, gr);
                    pushers.push(cand);
                }
            }
        }
    } finally {
        _pushingNeighbors = false;
    }
}

/**
 * Resolve colisões entre grupos ao soltar o mouse após mover um ou mais EVM Groups (`onDrop`).
 * Permite cruzar livremente outros grupos durante o arraste (para trocar posições no canvas)
 * e, ao soltar, empurra em cascata os grupos vizinhos garantindo o espaçamento canônico `PAD` (30px).
 *
 * @param {Array<{gr: object, startX: number, startY: number}>} movedItems
 * @param {object} [graph]
 */
function resolveGroupCollisionsOnMoveDrop(movedItems, graph = null) {
    if (!EVM_CFG.pushNeighborsOnExpand || !Array.isArray(movedItems) || !movedItems.length || _pushingNeighbors) return;
    const gr = graph || curGraph();
    if (!gr) return;

    const rawMoved = movedItems.filter(it =>
        it && it.gr && !isHiddenGroup(it.gr) &&
        (Math.abs(it.gr.x - it.startX) >= 4 || Math.abs(it.gr.y - it.startY) >= 4)
    );
    if (!rawMoved.length) return;

    // Ignora subgrupos aninhados cujo grupo pai também está sendo movido no mesmo lote
    const topMoved = rawMoved.filter(it =>
        !rawMoved.some(other => other !== it && containsBox(other.gr, it.gr))
    );
    if (!topMoved.length) return;

    const movedRawSet = new Set();
    for (const it of rawMoved) {
        movedRawSet.add(it.gr);
        for (const sub of containedEvmGroups(it.gr)) movedRawSet.add(sub);
    }

    _pushingNeighbors = true;
    try {
        const groupGap = PAD; // 3 quadradinhos (30px)
        const descriptors = [];

        const isNestedWithAnyMoved = (box) =>
            topMoved.some(it => containsBox(it.gr, box) || containsBox(box, it.gr));

        // 1. EVM Groups estacionários
        for (const eg of ensureEvmGroups(gr)) {
            if (!eg || movedRawSet.has(eg) || isHiddenGroup(eg)) continue;
            if (isNestedWithAnyMoved(eg)) continue;
            descriptors.push({ kind: "evmgroup", raw: eg, x: eg.x, y: eg.y, w: eg.w, h: eg.h });
        }
        // 2. Pixaroma Groups estacionários
        const pixArr = gr.extra?.pixaromaGroups;
        if (Array.isArray(pixArr)) {
            for (const pg of pixArr) {
                if (!pg || isNestedWithAnyMoved(pg)) continue;
                descriptors.push({ kind: "pixgroup", raw: pg, x: pg.x, y: pg.y, w: pg.w, h: pg.h });
            }
        }
        // 3. Native ComfyUI Groups estacionários
        const natArr = gr._groups || gr.groups;
        if (Array.isArray(natArr)) {
            for (const ng of natArr) {
                if (!ng) continue;
                const pos = ng._pos || ng.pos;
                const size = ng._size || ng.size;
                if (pos && size) {
                    const box = { x: pos[0], y: pos[1], w: size[0], h: size[1] };
                    if (isNestedWithAnyMoved(box)) continue;
                    descriptors.push({ kind: "nativegroup", raw: ng, x: box.x, y: box.y, w: box.w, h: box.h });
                }
            }
        }

        if (!descriptors.length) return;

        // Ordena grupos movidos da esquerda para a direita, topo para a base
        const sortedMoved = topMoved.slice().sort((a, b) => (a.gr.x - b.gr.x) || (a.gr.y - b.gr.y));

        const isVerticalStackCollision = (a, b) => {
            const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (overlapW <= 0) return false;
            if (overlapH <= 0) return true; // Mesma coluna X, separados apenas pelo gap Y
            const aCx = a.x + a.w / 2, aCy = a.y + a.h / 2;
            const bCx = b.x + b.w / 2, bCy = b.y + b.h / 2;
            return (
                overlapW > Math.min(a.w, b.w) * 0.5 &&
                overlapH < overlapW * 0.6 &&
                Math.abs(aCy - bCy) > Math.abs(aCx - bCx)
            );
        };

        for (const item of sortedMoved) {
            const mg = item.gr;
            const dx = mg.x - item.startX;
            const dy = mg.y - item.startY;
            const mDesc = { kind: "evmgroup", raw: mg, x: mg.x, y: mg.y, w: mg.w, h: mg.h };

            // Identifica colisões horizontais diretas com o grupo solto
            const mCx = mDesc.x + mDesc.w / 2;
            const horizLeftHits = [];
            const horizRightHits = [];

            for (const d of descriptors) {
                const overlapsY = (d.y < mDesc.y + mDesc.h) && (d.y + d.h > mDesc.y);
                const hitsX = (d.x < mDesc.x + mDesc.w + groupGap) && (d.x + d.w > mDesc.x - groupGap);
                if (overlapsY && hitsX && !isVerticalStackCollision(mDesc, d)) {
                    const dCx = d.x + d.w / 2;
                    if (dCx < mCx) horizLeftHits.push(d);
                    else horizRightHits.push(d);
                }
            }

            // Se o grupo foi solto encostando na borda direita de um grupo à esquerda (horizLeftHits)
            // e ou estava indo para a direita (dx >= -10) ou foi solto ENTRE dois grupos (horizRightHits.length > 0),
            // encaixa o próprio grupo movido a 30px após o grupo da esquerda antes de empurrar os da direita!
            const shouldPushLeft = (dx < -10) && horizLeftHits.length > 0 && horizRightHits.length === 0;
            if (horizLeftHits.length > 0 && !shouldPushLeft) {
                let minAllowedX = mDesc.x;
                for (const lh of horizLeftHits) {
                    const reqX = snap(lh.x + lh.w + groupGap);
                    if (reqX > minAllowedX) minAllowedX = reqX;
                }
                if (minAllowedX > mDesc.x) {
                    shiftGroupDescriptorByDelta(mDesc, minAllowedX - mDesc.x, 0, gr);
                }
            }

            // A) Cascata para a Direita (padrão principal de fluxo horizontal)
            {
                const rightCands = descriptors
                    .filter(d => (d.x + d.w / 2) >= (mDesc.x + mDesc.w / 2) || d.x >= mDesc.x)
                    .sort((a, b) => a.x - b.x);
                const pushers = [mDesc];

                for (const cand of rightCands) {
                    let targetX = cand.x;
                    for (const p of pushers) {
                        const overlapsY = (cand.y < p.y + p.h) && (cand.y + cand.h > p.y);
                        const hitsX = (cand.x < p.x + p.w + groupGap) && (cand.x + cand.w > p.x - groupGap);
                        if (overlapsY && hitsX) {
                            if (p === mDesc && isVerticalStackCollision(mDesc, cand)) continue;
                            const reqX = snap(p.x + p.w + groupGap);
                            if (reqX > targetX) targetX = reqX;
                        }
                    }
                    if (targetX > cand.x) {
                        shiftGroupDescriptorByDelta(cand, targetX - cand.x, 0, gr);
                        pushers.push(cand);
                    }
                }
            }

            // B) Cascata para a Esquerda (quando arrastado para a esquerda contra um grupo sem vizinho bloqueando à direita)
            if (shouldPushLeft) {
                const leftCands = descriptors
                    .filter(d => (d.x + d.w / 2) < (mDesc.x + mDesc.w / 2))
                    .sort((a, b) => (b.x + b.w) - (a.x + a.w));
                const pushers = [mDesc];

                for (const cand of leftCands) {
                    let targetX = cand.x;
                    for (const p of pushers) {
                        const overlapsY = (cand.y < p.y + p.h) && (cand.y + cand.h > p.y);
                        const hitsX = (cand.x < p.x + p.w + groupGap) && (cand.x + cand.w > p.x - groupGap);
                        if (overlapsY && hitsX) {
                            if (p === mDesc && isVerticalStackCollision(mDesc, cand)) continue;
                            const reqX = snap(p.x - groupGap - cand.w);
                            if (reqX < targetX) targetX = reqX;
                        }
                    }
                    if (targetX < cand.x) {
                        shiftGroupDescriptorByDelta(cand, targetX - cand.x, 0, gr);
                        pushers.push(cand);
                    }
                }
            }

            // C) Colisões Verticais (quando grupos estão empilhados na mesma coluna)
            const mCy = mDesc.y + mDesc.h / 2;
            const vertTopHits = [];
            const vertBottomHits = [];
            for (const d of descriptors) {
                const overlapsX = (d.x < mDesc.x + mDesc.w) && (d.x + d.w > mDesc.x);
                const hitsY = (d.y < mDesc.y + mDesc.h + groupGap) && (d.y + d.h > mDesc.y - groupGap);
                if (overlapsX && hitsY) {
                    const dCy = d.y + d.h / 2;
                    if (dCy < mCy) vertTopHits.push(d);
                    else vertBottomHits.push(d);
                }
            }

            const shouldPushUp = (dy < -10) && vertTopHits.length > 0 && vertBottomHits.length === 0;
            if (vertTopHits.length > 0 && !shouldPushUp) {
                let minAllowedY = mDesc.y;
                for (const th of vertTopHits) {
                    const reqY = snap(th.y + th.h + groupGap);
                    if (reqY > minAllowedY) minAllowedY = reqY;
                }
                if (minAllowedY > mDesc.y) {
                    shiftGroupDescriptorByDelta(mDesc, 0, minAllowedY - mDesc.y, gr);
                }
            }

            // Cascata para Baixo
            {
                const downCands = descriptors
                    .filter(d => (d.y + d.h / 2) >= (mDesc.y + mDesc.h / 2) || d.y >= mDesc.y)
                    .sort((a, b) => a.y - b.y);
                const pushers = [mDesc];

                for (const cand of downCands) {
                    let targetY = cand.y;
                    for (const p of pushers) {
                        const overlapsX = (cand.x < p.x + p.w) && (cand.x + cand.w > p.x);
                        const hitsY = (cand.y < p.y + p.h + groupGap) && (cand.y + cand.h > p.y - groupGap);
                        if (overlapsX && hitsY) {
                            const reqY = snap(p.y + p.h + groupGap);
                            if (reqY > targetY) targetY = reqY;
                        }
                    }
                    if (targetY > cand.y) {
                        shiftGroupDescriptorByDelta(cand, 0, targetY - cand.y, gr);
                        pushers.push(cand);
                    }
                }
            }

            // Cascata para Cima
            if (shouldPushUp) {
                const upCands = descriptors
                    .filter(d => (d.y + d.h / 2) < (mDesc.y + mDesc.h / 2))
                    .sort((a, b) => (b.y + b.h) - (a.y + a.h));
                const pushers = [mDesc];

                for (const cand of upCands) {
                    let targetY = cand.y;
                    for (const p of pushers) {
                        const overlapsX = (cand.x < p.x + p.w) && (cand.x + cand.w > p.x);
                        const hitsY = (cand.y < p.y + p.h + groupGap) && (cand.y + cand.h > p.y - groupGap);
                        if (overlapsX && hitsY) {
                            const reqY = snap(p.y - groupGap - cand.h);
                            if (reqY < targetY) targetY = reqY;
                        }
                    }
                    if (targetY < cand.y) {
                        shiftGroupDescriptorByDelta(cand, 0, targetY - cand.y, gr);
                        pushers.push(cand);
                    }
                }
            }
        }
    } finally {
        _pushingNeighbors = false;
    }
}

function computeRailsSignature(getNodes, setNodes) {
    let s = "";
    for (const n of getNodes) {
        s += `G${n.id}:${n.flags?.collapsed ? 1 : 0}:${n.flags?.collapsed ? 0 : Math.round(n.size?.[0] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    s += "|";
    for (const n of setNodes) {
        s += `S${n.id}:${n.flags?.collapsed ? 1 : 0}:${n.flags?.collapsed ? 0 : Math.round(n.size?.[0] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    return s;
}

function layoutDockedNodes(g, graph, opts = {}) {
    if (!g || g.folded) return;
    const gr = graph || curGraph();
    if (!gr || isGraphConfiguring(gr)) return;
    ensureDockArrays(g);

    const prevBounds = opts.prevBounds || { x: g.x, y: g.y, w: g.w, h: g.h };

    const getNodes = resolveNodeList(gr, g.getNodeIds);
    const setNodes = resolveNodeList(gr, g.setNodeIds);

    // 1. Calcula a largura do GetNode mais largo no trilho esquerdo
    let widestGet = MIN_RAIL_INNER_W;
    for (const n of getNodes) {
        const w = getDockedNodeActiveWidth(n);
        if (w > widestGet) widestGet = w;
    }
    const targetLeftW = snapUp(widestGet + PAD * 2); // 3 quadradinhos (30px) de margem de cada lado

    // 2. Calcula a largura do SetNode mais largo no trilho direito
    let widestSet = MIN_RAIL_INNER_W;
    for (const n of setNodes) {
        const w = getDockedNodeActiveWidth(n);
        if (w > widestSet) widestSet = w;
    }
    const targetRightW = snapUp(widestSet + PAD * 2); // 3 quadradinhos (30px) de margem de cada lado

    // 3. Mantém g.x ancorado e garante que a Área Central tenha sempre PAD (30px) à esquerda e à direita.
    //    Só recalcula leftRailW/rightRailW quando os próprios GetNodes/SetNodes mudaram (ou forceRailWidthRecalc),
    //    evitando que redimensionar um nó central altere a largura do trilho e desloque a área central.
    const oldLeftOpenW = g.leftRailOpen === false ? 0 : (g.leftRailW || DEFAULT_RAIL_W);
    const oldRightOpenW = g.rightRailOpen === false ? 0 : (g.rightRailW || DEFAULT_RAIL_W);

    const centralNodes = opts.centralNodes || getCentralMemberNodes(g, gr);

    const railSig = computeRailsSignature(getNodes, setNodes);
    const railsUnchanged = (
        !opts.forceRailWidthRecalc &&
        g._lastRailSig !== undefined &&
        g._lastRailSig === railSig &&
        Number.isFinite(g.leftRailW) &&
        Number.isFinite(g.rightRailW)
    );
    if (!railsUnchanged) {
        g.leftRailW = targetLeftW;
        g.rightRailW = targetRightW;
        g._lastRailSig = railSig;
    }

    const newLeftOpenW = g.leftRailOpen === false ? 0 : g.leftRailW;
    const newRightOpenW = g.rightRailOpen === false ? 0 : g.rightRailW;

    g.x = snap(g.x);
    const centerX0 = snap(g.x + newLeftOpenW);
    let currentCenterW = Math.max(MIN_CENTER_W, snap(g.w - oldLeftOpenW - oldRightOpenW));

    if (!opts.skipCentralShift && _drag?.mode !== "resize" && !app.canvas?.node_dragged && !app.canvas?.resizing_node && centralNodes.length > 0) {
        let minX = Infinity;
        let maxRight = -Infinity;
        for (const cn of centralNodes) {
            if (!cn || !cn.pos) continue;
            const nx = snap(cn.pos[0]);
            const nw = cn.flags?.collapsed ? computeNodeCollapsedWidth(cn) : snapUp(cn.size?.[0] || 140);
            if (nx < minX) minX = nx;
            if (nx + nw > maxRight) maxRight = nx + nw;
        }
        if (Number.isFinite(minX) && Number.isFinite(maxRight)) {
            const targetMinX = snap(centerX0 + PAD);
            const dxCenter = snap(targetMinX - minX);
            if (dxCenter !== 0) {
                for (const cn of centralNodes) {
                    if (!cn || !cn.pos) continue;
                    const nextX = snap(cn.pos[0] + dxCenter);
                    const nextY = snap(cn.pos[1]);
                    setNodePos(cn, nextX, nextY);
                    cn._evmAlignedX = nextX;
                    cn._evmAlignedY = nextY;
                }
            }
            currentCenterW = Math.max(MIN_CENTER_W, snap((maxRight - minX) + PAD * 2));
        }
    }

    g.w = snap(newLeftOpenW + currentCenterW + newRightOpenW);
    g.y = snap(g.y);

    // 4. Posiciona os GetNodes e SetNodes com margem de 3 quadradinhos (30px) abaixo do sub-header
    //    e gap vertical de 3 quadradinhos visíveis (NODE_VGAP = 60px) entre eles.
    //    Topo do 1º nó nos trilhos: g.y + HEADER_H (30) + SUB_HEADER_H (30) + PAD (30) + NODE_TITLE_H (30) = g.y + 120
    const railStartY = snap(g.y + HEADER_H + SUB_HEADER_H + PAD + NODE_TITLE_H);
    let maxBottomY = snap(g.y + MIN_GROUP_H - PAD);

    // Empilha GetNodes no trilho esquerdo
    let curY = railStartY;
    const leftNodeX = snap(g.x + PAD);
    for (const n of getNodes) {
        setNodePos(n, leftNodeX, curY);
        const bodyH = getNodeActiveBodyHeight(n);
        if (!opts.isLiveReflow && !n.flags?.collapsed && n.size) n.size[1] = bodyH;
        curY += bodyH + NODE_VGAP;
    }
    if (getNodes.length && g.leftRailOpen !== false) {
        // O último curY somou NODE_VGAP (60px); a base visual do último nó é curY - NODE_VGAP
        maxBottomY = Math.max(maxBottomY, curY - NODE_VGAP);
    }

    // Empilha SetNodes no trilho direito
    curY = railStartY;
    const rightRailX0 = snap(g.x + g.w - (g.rightRailW || DEFAULT_RAIL_W));
    const rightNodeX = snap(rightRailX0 + PAD);
    for (const n of setNodes) {
        setNodePos(n, rightNodeX, curY);
        const bodyH = getNodeActiveBodyHeight(n);
        if (!opts.isLiveReflow && !n.flags?.collapsed && n.size) n.size[1] = bodyH;
        curY += bodyH + NODE_VGAP;
    }
    if (setNodes.length && g.rightRailOpen !== false) {
        maxBottomY = Math.max(maxBottomY, curY - NODE_VGAP);
    }

    // 5. Considera também a base visual dos nós centrais para garantir margem inferior de 3 quadradinhos (PAD = 30px)
    for (const cn of centralNodes) {
        const bodyH = getNodeActiveBodyHeight(cn);
        const nodeBottom = snap(cn.pos[1]) + bodyH;
        if (nodeBottom > maxBottomY) maxBottomY = nodeBottom;
    }

    const requiredH = Math.max(MIN_GROUP_H, snap((maxBottomY + PAD) - g.y));
    if (opts.shrinkHeightToFit || requiredH > g.h) {
        g.h = requiredH;
    }

    if (!opts.skipPush) {
        pushNeighborGroupsOnExpand(g, prevBounds, gr);
    }
}

/**
 * Organiza os custom nodes da Área Central do grupo aplicando a geometria canônica
 * da skill `organizar-workflows`:
 * - Margem de 3 quadradinhos (PAD = 30px) à esquerda, à direita, na base e abaixo da barra de título (g.y + 30).
 * - Gap de 3 quadradinhos visíveis (NODE_VGAP = 60px) verticalmente entre os nós da mesma coluna.
 * - Gap de 3 quadradinhos (NODE_HGAP = 30px) horizontalmente entre colunas.
 * - Redimensiona a largura do grupo (g.w) e a altura (g.h) em tempo real ao redimensionar
 *   qualquer nó horizontalmente ou verticalmente, empurrando grupos vizinhos para não sobrepor.
 */
function tidyGroupCentralNodes(g, graph, explicitCentralNodes = null, opts = {}) {
    if (!g || g.folded) return;
    const gr = graph || curGraph();
    if (!gr || isGraphConfiguring(gr)) return;
    ensureDockArrays(g);

    const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };

    const centralNodes = explicitCentralNodes || getCentralMemberNodes(g, gr);
    if (!centralNodes.length) {
        layoutDockedNodes(g, gr, { shrinkHeightToFit: true, isLiveReflow: opts.isLiveReflow, prevBounds });
        return;
    }

    // Primeiro garante que leftRailW e rightRailW já estejam calculados para os Set/Get atuais
    layoutDockedNodes(g, gr, { centralNodes, isLiveReflow: opts.isLiveReflow, skipPush: true, skipCentralShift: true });

    const lOpenW = leftRailW(g);
    const rOpenW = rightRailW(g);
    const centerX0 = snap(g.x + lOpenW);

    const subCols = clusterIntoSubColumns(centralNodes);

    // Topo do 1º nó central: 3 quadradinhos (30px) abaixo da base do título (g.y + HEADER_H)
    // Como a barra de título do próprio nó tem 30px acima de pos[1], pos[1] = g.y + 30 + 30 + 30 = g.y + 90
    const centralStartY = snap(g.y + HEADER_H + PAD + NODE_TITLE_H);

    let colX = snap(centerX0 + PAD);
    let maxCentralBottom = snap(g.y + HEADER_H + PAD);

    for (const col of subCols) {
        // Calcula a largura mais larga da sub-coluna
        let colWidest = 140;
        for (const n of col) {
            if (n.flags?.collapsed) {
                const cw = computeNodeCollapsedWidth(n);
                if (cw > colWidest) colWidest = cw;
            } else {
                const nw = snapUp(n.size?.[0] || 140);
                if (nw > colWidest) colWidest = nw;
            }
        }

        // Posiciona os nós da sub-coluna respeitando o gap vertical de 3 quadradinhos (NODE_VGAP = 60px).
        // Durante redimensionamento ao vivo (isLiveReflow), não sobrescreve n.size[0]/n.size[1] para não
        // travar o cursor nem impedir encolhimento horizontal quando há múltiplos nós na coluna.
        let yCursor = centralStartY;
        for (const n of col) {
            if (!opts.isLiveReflow && !n.flags?.collapsed && n.size) {
                n.size[0] = snapUp(n.size[0] || 140);
                n.size[1] = snapUp(n.size[1] || 30);
            }
            setNodePos(n, colX, yCursor);
            n._evmAlignedX = colX;
            n._evmAlignedY = yCursor;
            const bodyH = getNodeActiveBodyHeight(n);
            yCursor += bodyH + NODE_VGAP;
        }

        const colBottom = yCursor - NODE_VGAP;
        if (colBottom > maxCentralBottom) maxCentralBottom = colBottom;

        colX = snap(colX + colWidest + NODE_HGAP);
    }

    // Margem direita de 3 quadradinhos (PAD = 30px) após a última sub-coluna
    const requiredCenterW = Math.max(MIN_CENTER_W, snap((colX - NODE_HGAP + PAD) - centerX0));
    g.w = snap(lOpenW + requiredCenterW + rOpenW);

    // Reposiciona o trilho direito, ajusta a altura final do grupo e empurra vizinhos se cresceu
    layoutDockedNodes(g, gr, { centralNodes, shrinkHeightToFit: true, isLiveReflow: opts.isLiveReflow, prevBounds, skipCentralShift: true });
}

function syncGroupLayoutSignature(g, graph, explicitCentralNodes = null) {
    if (!g) return;
    const gr = graph || curGraph();
    if (!gr) return;
    ensureDockArrays(g);
    const getNodes = resolveNodeList(gr, g.getNodeIds);
    const setNodes = resolveNodeList(gr, g.setNodeIds);
    const centralNodes = explicitCentralNodes || getCentralMemberNodes(g, gr);

    g._lastRailSig = computeRailsSignature(getNodes, setNodes);

    let sig = `${g.leftRailOpen}:${g.rightRailOpen}|`;
    for (const n of getNodes) {
        sig += `G${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    for (const n of setNodes) {
        sig += `S${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    for (const cn of centralNodes) {
        const cFlag = cn.flags?.collapsed ? 1 : 0;
        const cW = Math.round(cn.size?.[0] || 140);
        const cH = cFlag ? 0 : Math.round(cn.size?.[1] || 30);
        const cX = Math.round(cn.pos?.[0] || 0);
        const cY = Math.round(cn.pos?.[1] || 0);
        cn._evmPrevCollapsed = cFlag;
        cn._evmPrevW = cW;
        cn._evmPrevBodyH = cH;
        cn._evmAlignedX = cX;
        cn._evmAlignedY = cY;
        sig += `C${cn.id}:${cFlag}:${cW}:${cH}:${cX}:${cY};`;
    }
    g._lastLayoutSig = sig;
}

/**
 * Monitora alterações de estado maximizado/minimizado (collapse) ou tamanho (horizontal e vertical)
 * dos nós dentro de cada EVM Group e faz reflow imediato para que o grupo e os nós acompanhem em tempo real.
 */
function checkAndReflowGroupIfNeeded(g, graph) {
    if (!EVM_CFG.autoReflow || !g || g.folded || _drag || _carry || app.canvas?.dragging_rectangle) return;
    const gr = graph || curGraph();
    if (!gr || isGraphConfiguring(gr)) return;
    ensureDockArrays(g);

    const getNodes = resolveNodeList(gr, g.getNodeIds);
    const setNodes = resolveNodeList(gr, g.setNodeIds);
    const centralNodes = getCentralMemberNodes(g, gr);
    const resizingNode = app.canvas?.resizing_node;

    // Gera assinatura de estado (collapsed, largura, altura, título e posição durante resize) dos nós do grupo
    let sig = `${g.leftRailOpen}:${g.rightRailOpen}|`;
    for (const n of getNodes) {
        sig += `G${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    for (const n of setNodes) {
        sig += `S${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }

    let centralCollapseOrSizeChanged = false;
    const isInitialLoad = (g._lastLayoutSig === undefined);
    for (const cn of centralNodes) {
        const cFlag = cn.flags?.collapsed ? 1 : 0;
        const cW = Math.round(cn.size?.[0] || 140);
        const cH = cFlag ? 0 : Math.round(cn.size?.[1] || 30);
        const cX = Math.round(cn.pos?.[0] || 0);
        const cY = Math.round(cn.pos?.[1] || 0);
        const posDriftedDuringResize = (
            resizingNode === cn &&
            cn._evmAlignedX !== undefined &&
            (cX !== cn._evmAlignedX || cY !== cn._evmAlignedY)
        );
        if (
            cn._evmPrevCollapsed !== undefined &&
            (cn._evmPrevCollapsed !== cFlag || cn._evmPrevW !== cW || cn._evmPrevBodyH !== cH || posDriftedDuringResize)
        ) {
            centralCollapseOrSizeChanged = true;
        }
        cn._evmPrevCollapsed = cFlag;
        cn._evmPrevW = cW;
        cn._evmPrevBodyH = cH;
        if (isInitialLoad || cn._evmAlignedX === undefined) {
            cn._evmAlignedX = cX;
            cn._evmAlignedY = cY;
        }
        sig += `C${cn.id}:${cFlag}:${cW}:${cH}:${posDriftedDuringResize ? `${cX}:${cY}` : `${cn._evmAlignedX}:${cn._evmAlignedY}`};`;
    }

    if (sig === g._lastLayoutSig) return;
    g._lastLayoutSig = sig;

    // Na primeira renderização após abrir um workflow ou trocar de aba (isInitialLoad),
    // apenas registra a assinatura inicial sem forçar reflow nem mover nós entre grupos!
    if (isInitialLoad) {
        g._lastRailSig = computeRailsSignature(getNodes, setNodes);
        return;
    }

    if (centralCollapseOrSizeChanged) {
        tidyGroupCentralNodes(g, gr, centralNodes, { isLiveReflow: true });
    } else {
        layoutDockedNodes(g, gr, { centralNodes, shrinkHeightToFit: true, isLiveReflow: true });
    }

    syncGroupLayoutSignature(g, gr, centralNodes);
}

/**
 * Aplica a regra de nomenclatura <NomeDoGrupo>_<TIPO> no SetNode ancorado
 * e sincroniza widgets_values + widgets_values_named + GetNodes pareados.
 */
function applyGroupNamingToSetNode(setNode, g, typeHint) {
    if (!setNode || !g) return;
    if (EVM_CFG.autoNamingFormat === "Desativado") {
        layoutDockedNodes(g, setNode.graph || curGraph());
        return;
    }
    const graph = setNode.graph || curGraph();
    const prefix = sanitizeGroupPrefix(g.title);
    const rawType = (typeHint && typeHint !== "*")
        ? String(typeHint).split(",")[0].trim().toUpperCase()
        : (setNode.inputs?.[0]?.type && setNode.inputs[0].type !== "*"
            ? String(setNode.inputs[0].type).split(",")[0].trim().toUpperCase()
            : "OUT");

    const baseName = EVM_CFG.autoNamingFormat === "<TIPO>_<Grupo>"
        ? `${rawType}_${prefix}`
        : `${prefix}_${rawType}`;

    const existing = new Set();
    for (const n of (graph?._nodes || [])) {
        if (n !== setNode && n.type === "SetNode" && n.widgets?.[0]?.value) {
            existing.add(String(n.widgets[0].value));
        }
    }

    let finalName = baseName;
    let idx = 2;
    while (existing.has(finalName)) {
        finalName = `${baseName}_${idx}`;
        idx++;
    }

    const prevName = setNode.widgets?.[0]?.value || setNode.properties?.previousName || "";
    if (!setNode.properties) setNode.properties = {};
    setNode.properties.previousName = prevName;
    setNode.properties.evmGroupPrefix = prefix;
    setNode.properties.evmAutoNamed = true;

    syncWidgetValue(setNode, 0, setNode.widgets?.[0]?.name || "Constant", finalName);
    setNode.title = "Set_" + finalName;
    setNode.properties.previousName = finalName;

    // Ajusta largura do SetNode para caber o novo nome sem truncar
    const reqW = computeSetGetExpandedRequiredWidth(setNode);
    if (setNode.size) {
        setNode.size[0] = reqW;
        setNode._evmAutoW = reqW;
    }

    if (typeof setNode.update === "function") {
        try { setNode.update(); } catch (_e) {}
    }
    for (const n of (graph?._nodes || [])) {
        if (n.type === "GetNode" && prevName && n.widgets?.[0]?.value === prevName) {
            syncWidgetValue(n, 0, n.widgets?.[0]?.name || "Constant", finalName);
            n.onRename?.();
            const gReqW = computeSetGetExpandedRequiredWidth(n);
            if (n.size) {
                n.size[0] = gReqW;
                n._evmAutoW = gReqW;
            }
        }
    }

    layoutDockedNodes(g, graph);
}

/**
 * Quando o título do grupo é renomeado, atualiza automaticamente o prefixo
 * de todos os SetNodes ancorados naquele grupo (e seus GetNodes pareados).
 */
function syncDockedSetNodesOnGroupRename(g, oldTitle, newTitle) {
    const graph = curGraph();
    if (!graph || !g) return;
    if (!EVM_CFG.syncRenameOnGroupTitle || EVM_CFG.autoNamingFormat === "Desativado") {
        layoutDockedNodes(g, graph);
        return;
    }
    const oldPrefix = sanitizeGroupPrefix(oldTitle);
    const newPrefix = sanitizeGroupPrefix(newTitle);
    if (oldPrefix === newPrefix) return;

    const setNodes = resolveNodeList(graph, g.setNodeIds);
    for (const sn of setNodes) {
        const curVal = String(sn.widgets?.[0]?.value || "");
        let suffix = "";
        if (curVal.startsWith(oldPrefix + "_")) {
            suffix = curVal.slice(oldPrefix.length + 1);
        } else if (curVal.endsWith("_" + oldPrefix)) {
            suffix = curVal.slice(0, curVal.length - oldPrefix.length - 1);
        } else {
            const inType = sn.inputs?.[0]?.type;
            suffix = (inType && inType !== "*") ? String(inType).toUpperCase() : "OUT";
        }

        const existing = new Set();
        for (const n of (graph._nodes || [])) {
            if (n !== sn && n.type === "SetNode" && n.widgets?.[0]?.value) {
                existing.add(String(n.widgets[0].value));
            }
        }

        const baseName = EVM_CFG.autoNamingFormat === "<TIPO>_<Grupo>"
            ? `${suffix}_${newPrefix}`
            : `${newPrefix}_${suffix}`;
        let finalName = baseName;
        let idx = 2;
        while (existing.has(finalName)) {
            finalName = `${baseName}_${idx}`;
            idx++;
        }

        if (!sn.properties) sn.properties = {};
        sn.properties.previousName = curVal;
        sn.properties.evmGroupPrefix = newPrefix;

        syncWidgetValue(sn, 0, sn.widgets?.[0]?.name || "Constant", finalName);
        sn.title = "Set_" + finalName;

        const reqW = computeSetGetExpandedRequiredWidth(sn);
        if (sn.size) {
            sn.size[0] = reqW;
            sn._evmAutoW = reqW;
        }

        for (const gn of (graph._nodes || [])) {
            if (gn.type === "GetNode" && gn.widgets?.[0]?.value === curVal) {
                syncWidgetValue(gn, 0, gn.widgets?.[0]?.name || "Constant", finalName);
                gn.onRename?.();
                const gReqW = computeSetGetExpandedRequiredWidth(gn);
                if (gn.size) {
                    gn.size[0] = gReqW;
                    gn._evmAutoW = gReqW;
                }
            }
        }
        sn.properties.previousName = finalName;
        try { sn.update?.(); } catch (_e) {}
    }

    layoutDockedNodes(g, graph);
}

function addDockedGetNode(g) {
    const graph = curGraph();
    if (!graph || !g) return null;
    ensureDockArrays(g);
    if (g.leftRailOpen === false) {
        toggleLeftRail(g, true);
    }

    const node = window.LiteGraph?.createNode?.("GetNode");
    if (!node) {
        toast("GetNode indisponível", "Verifique se o pacote KJNodes está ativo.");
        return null;
    }
    graph.add(node);
    g.getNodeIds.push(node.id);

    if (node.widgets?.[0]) {
        syncWidgetValue(node, 0, node.widgets[0].name || "Constant", node.widgets[0].value || "");
    }
    const reqW = computeSetGetExpandedRequiredWidth(node);
    if (node.size) {
        node.size[0] = reqW;
        node.size[1] = getNodeActiveBodyHeight(node);
        node._evmAutoW = reqW;
    }

    layoutDockedNodes(g, graph);
    invalidateHidden();
    updateHideCSS();
    markChanged();
    return node;
}

function addDockedSetNode(g, sourceLinkInfo = null) {
    const graph = curGraph();
    if (!graph || !g) return null;
    ensureDockArrays(g);
    if (g.rightRailOpen === false) {
        toggleRightRail(g, true);
    }

    const node = window.LiteGraph?.createNode?.("SetNode");
    if (!node) {
        toast("SetNode indisponível", "Verifique se o pacote KJNodes está ativo.");
        return null;
    }
    graph.add(node);
    g.setNodeIds.push(node.id);

    applyGroupNamingToSetNode(node, g, sourceLinkInfo?.type || "OUT");
    if (node.size) {
        node.size[1] = getNodeActiveBodyHeight(node);
    }
    layoutDockedNodes(g, graph);

    invalidateHidden();
    updateHideCSS();
    markChanged();
    return node;
}

/**
 * Oculta ou exibe o trilho esquerdo (GetNode) mantendo a Área Central imóvel no canvas.
 */
function toggleLeftRail(g, forceState) {
    if (!g || g.folded) return;
    ensureDockArrays(g);
    const nextOpen = typeof forceState === "boolean" ? forceState : (g.leftRailOpen === false);
    if (nextOpen === (g.leftRailOpen !== false)) return;

    const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };
    const rw = g.leftRailW || DEFAULT_RAIL_W;
    if (nextOpen) {
        g.leftRailOpen = true;
        g.x = snap(g.x - rw);
        g.w = snap(g.w + rw);
    } else {
        g.leftRailOpen = false;
        g.x = snap(g.x + rw);
        g.w = Math.max(MIN_CENTER_W + rightRailW(g), snap(g.w - rw));
    }
    layoutDockedNodes(g, curGraph(), { shrinkHeightToFit: true, prevBounds });
    invalidateHidden();
    updateHideCSS();
    markChanged();
}

/**
 * Oculta ou exibe o trilho direito (SetNode) mantendo a Área Central imóvel no canvas.
 */
function toggleRightRail(g, forceState) {
    if (!g || g.folded) return;
    ensureDockArrays(g);
    const nextOpen = typeof forceState === "boolean" ? forceState : (g.rightRailOpen === false);
    if (nextOpen === (g.rightRailOpen !== false)) return;

    const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };
    const rw = g.rightRailW || DEFAULT_RAIL_W;
    if (nextOpen) {
        g.rightRailOpen = true;
        g.w = snap(g.w + rw);
    } else {
        g.rightRailOpen = false;
        g.w = Math.max(leftRailW(g) + MIN_CENTER_W, snap(g.w - rw));
    }
    layoutDockedNodes(g, curGraph(), { shrinkHeightToFit: true, prevBounds });
    invalidateHidden();
    updateHideCSS();
    markChanged();
}

// ── Membros do Grupo, Fold e Ocultação de Nós/Fios ─────────────────────────
function containedNodes(g) {
    const graph = curGraph();
    if (!graph) return [];
    ensureDockArrays(g);
    const allGroups = ensureEvmGroups(graph);
    const validGroupIds = new Set(allGroups.filter(Boolean).map(og => og.id));
    const ownDockedSet = new Set([
        ...g.getNodeIds.map(String),
        ...g.setNodeIds.map(String)
    ]);
    const otherDockedSet = new Set();
    for (const og of allGroups) {
        if (!og || og === g) continue;
        ensureDockArrays(og);
        for (const id of og.getNodeIds) otherDockedSet.add(String(id));
        for (const id of og.setNodeIds) otherDockedSet.add(String(id));
    }
    const out = [];
    for (const n of (graph._nodes || [])) {
        if (!n || !n.pos) continue;
        const sid = String(n.id);
        if (ownDockedSet.has(sid)) {
            out.push(n);
            continue;
        }
        if (otherDockedSet.has(sid)) continue;
        if (n._evmLastGroupId && validGroupIds.has(n._evmLastGroupId)) {
            if (n._evmLastGroupId === g.id) {
                out.push(n);
            }
            continue;
        }
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h) {
            n._evmLastGroupId = g.id;
            out.push(n);
        }
    }
    return out;
}

function groupMemberNodes(g) {
    const graph = curGraph();
    if (!graph) return [];
    if (g.folded && Array.isArray(g.foldNodes)) {
        const byId = {};
        for (const n of (graph._nodes || [])) byId[String(n.id)] = n;
        const out = [];
        for (const id of g.foldNodes) {
            const n = byId[String(id)];
            if (n) out.push(n);
        }
        return out;
    }
    return containedNodes(g);
}

function containedEvmGroups(g) {
    const out = [];
    for (const o of ensureEvmGroups()) {
        if (o === g) continue;
        if (containsBox(g, o)) out.push(o);
    }
    return out;
}

let _hiddenCache = null;
function invalidateHidden() { _hiddenCache = null; }

function buildHidden() {
    const hidden = new Set();
    const owner = new Map();
    const railHiddenSide = new Map();
    const hiddenGroups = new Set();

    for (const g of ensureEvmGroups()) {
        ensureDockArrays(g);
        if (g.folded && Array.isArray(g.foldNodes)) {
            for (const id of g.foldNodes) {
                const s = String(id);
                hidden.add(s);
                if (!owner.has(s)) owner.set(s, g);
            }
            if (Array.isArray(g.foldGroups)) {
                for (const gid of g.foldGroups) hiddenGroups.add(String(gid));
            }
            continue;
        }
        if (g.leftRailOpen === false && Array.isArray(g.getNodeIds)) {
            for (const id of g.getNodeIds) {
                const s = String(id);
                hidden.add(s);
                railHiddenSide.set(s, { group: g, side: "left" });
            }
        }
        if (g.rightRailOpen === false && Array.isArray(g.setNodeIds)) {
            for (const id of g.setNodeIds) {
                const s = String(id);
                hidden.add(s);
                railHiddenSide.set(s, { group: g, side: "right" });
            }
        }
    }
    return { hidden, owner, railHiddenSide, hiddenGroups };
}

function hiddenMaps() {
    if (!_hiddenCache) _hiddenCache = buildHidden();
    return _hiddenCache;
}

function isHiddenGroup(g) {
    return hiddenMaps().hiddenGroups.has(String(g.id));
}

let _hideCSSEl = null, _hideCSSKey = "";
function updateHideCSS() {
    let ids = [];
    try { ids = isVueNodes() ? [...hiddenMaps().hidden] : []; } catch (_e) {}
    const key = ids.slice().sort().join(",");
    if (key === _hideCSSKey) return;
    _hideCSSKey = key;
    if (!_hideCSSEl) {
        _hideCSSEl = document.createElement("style");
        _hideCSSEl.id = "evm-group-fold-hide";
        (document.head || document.documentElement).appendChild(_hideCSSEl);
    }
    _hideCSSEl.textContent = ids.map(id => `[data-node-id="${id}"]{display:none !important;}`).join("\n");
}

let _foldHooksInstalled = false;
function installFoldAndRailHideHooks() {
    if (_foldHooksInstalled) return;
    const proto = (window.LiteGraph?.LGraphCanvas || window.LGraphCanvas)?.prototype;
    if (!proto) {
        setTimeout(installFoldAndRailHideHooks, 200);
        return;
    }
    if (typeof proto.computeVisibleNodes === "function") {
        const origCVN = proto.computeVisibleNodes;
        proto.computeVisibleNodes = function (nodes, out) {
            const res = origCVN.call(this, nodes, out);
            try {
                const { hidden } = hiddenMaps();
                if (hidden.size && Array.isArray(res)) {
                    for (let i = res.length - 1; i >= 0; i--) {
                        if (hidden.has(String(res[i].id))) res.splice(i, 1);
                    }
                    const vn = this.visible_nodes;
                    if (Array.isArray(vn) && vn !== res) {
                        for (let i = vn.length - 1; i >= 0; i--) {
                            if (hidden.has(String(vn[i].id))) vn.splice(i, 1);
                        }
                    }
                }
            } catch (_e) {}
            return res;
        };
    }

    if (typeof proto.renderLink === "function") {
        const origRenderLink = proto.renderLink;
        proto.renderLink = function (ctx, a, b, link, skipBorder, flow, color, startDir, endDir, opts) {
            try {
                if (link && link.origin_id != null) {
                    const { owner, railHiddenSide } = hiddenMaps();
                    const origStr = String(link.origin_id);
                    const tgtStr = String(link.target_id);

                    const rOrig = railHiddenSide.get(origStr);
                    const rTgt = railHiddenSide.get(tgtStr);
                    if (rOrig || rTgt) {
                        const na = rOrig
                            ? [rOrig.group.x + 14, rOrig.group.y + HEADER_H / 2]
                            : a;
                        const nb = rTgt
                            ? [rTgt.group.x + rTgt.group.w - 14, rTgt.group.y + HEADER_H / 2]
                            : b;
                        return origRenderLink.call(this, ctx, na, nb, link, skipBorder, flow, color, startDir, endDir, opts);
                    }

                    if (owner.size) {
                        const oG = owner.get(origStr);
                        const tG = owner.get(tgtStr);
                        if (oG && tG && oG === tG) return;
                        if (oG || tG) {
                            const show = (oG ? oG.showLinks !== false : true) && (tG ? tG.showLinks !== false : true);
                            if (!show) return;
                            const na = oG ? [oG.x + oG.w, oG.y + oG.h / 2] : a;
                            const nb = tG ? [tG.x, tG.y + tG.h / 2] : b;
                            return origRenderLink.call(this, ctx, na, nb, link, skipBorder, flow, color, startDir, endDir, opts);
                        }
                    }
                }
            } catch (_e) {}
            return origRenderLink.call(this, ctx, a, b, link, skipBorder, flow, color, startDir, endDir, opts);
        };
    }
    _foldHooksInstalled = true;
}

function computeBarWidth(g) {
    const ctx = getMeasCtx();
    ctx.font = `600 ${gFontSize(g)}px 'Segoe UI', system-ui, sans-serif`;
    const tw = ctx.measureText(g.title || "EVM Group").width;
    return snapUp(Math.max(220, 16 + tw + 90));
}

function foldEvmGroup(g) {
    if (!g || g.folded) return;
    ensureDockArrays(g);
    const subs = containedEvmGroups(g);
    const ids = new Set(containedNodes(g).map(n => String(n.id)));
    for (const id of g.getNodeIds) ids.add(String(id));
    for (const id of g.setNodeIds) ids.add(String(id));
    for (const sg of subs) {
        for (const n of groupMemberNodes(sg)) ids.add(String(n.id));
    }
    g.foldNodes = [...ids];
    g.foldGroups = subs.map(sg => sg.id);
    g.hOpen = g.h;
    g.wOpen = g.w;
    g.folded = true;
    g.h = HEADER_H;
    g.w = computeBarWidth(g);
    if (g.showLinks == null) g.showLinks = EVM_CFG.showLinksWhenFolded;
    invalidateHidden();
    updateHideCSS();
    markChanged();
}

function unfoldEvmGroup(g) {
    if (!g || !g.folded) return;
    const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };
    g.folded = false;
    g.h = Math.max(MIN_GROUP_H, snap(g.hOpen || MIN_GROUP_H));
    g.w = Math.max(minGroupWidth(g), snap(g.wOpen || g.w));
    delete g.foldNodes;
    delete g.foldGroups;
    layoutDockedNodes(g, curGraph(), { prevBounds });
    invalidateHidden();
    updateHideCSS();
    markChanged();
}

function toggleFoldEvmGroup(g) {
    if (!g) return;
    if (g.folded) unfoldEvmGroup(g);
    else foldEvmGroup(g);
}

// ── Botões do Header e dos Sub-Headers (GetNode / SetNode) ──────────────────
const BSZ = 18, BGAP = 4, BPAD = 8, BICON = 12;

function headerButtons(g) {
    const hH = HEADER_H;
    const bw = 26, bh = 16;
    const badge = { x: g.x + g.w - BPAD - bw, y: g.y + (hH - bh) / 2, w: bw, h: bh };
    let rx = badge.x - 6;
    const isHoveredOrSelected = (g.id === _hoverId) || _selectedIds.has(g.id);
    let keys;
    if (g.folded) {
        keys = ["unfold"];
    } else if (EVM_CFG.headerBtnVis === "compact") {
        keys = ["fold"];
    } else if (EVM_CFG.headerBtnVis === "hover" && !isHoveredOrSelected) {
        keys = ["fold"];
    } else {
        keys = ["run", "mute", "bypass", "fold"];
    }
    const by = g.y + (hH - BSZ) / 2;
    const btns = [];
    for (let i = keys.length - 1; i >= 0; i--) {
        rx -= BSZ;
        btns.unshift({ key: keys[i], x: rx, y: by, w: BSZ, h: BSZ });
        rx -= BGAP;
    }

    // Se o trilho direito estiver oculto, coloca o botão "Set ◀" no próprio Header Superior
    // para NUNCA invadir a margem superior de 3 quadradinhos da Área Central
    if (!g.folded && g.rightRailOpen === false) {
        const count = Array.isArray(g.setNodeIds) ? g.setNodeIds.length : 0;
        const lbl = count > 0 ? `Set (${count}) ◀` : "Set ◀";
        const wPill = count > 0 ? 64 : 46;
        rx -= wPill;
        btns.unshift({
            key: "toggleRight",
            label: lbl,
            title: "Mostrar painel SetNode",
            x: rx,
            y: by,
            w: wPill,
            h: BSZ,
            isTextPill: true,
        });
        rx -= BGAP;
    }

    // Se o trilho esquerdo estiver oculto, coloca o botão "▶ Get" no início do Header Superior
    let leftOffset = g.x + 12;
    if (!g.folded && g.leftRailOpen === false) {
        const count = Array.isArray(g.getNodeIds) ? g.getNodeIds.length : 0;
        const lbl = count > 0 ? `▶ Get (${count})` : "▶ Get";
        const wPill = count > 0 ? 64 : 46;
        btns.push({
            key: "toggleLeft",
            label: lbl,
            title: "Mostrar painel GetNode",
            x: g.x + 8,
            y: by,
            w: wPill,
            h: BSZ,
            isTextPill: true,
        });
        leftOffset = g.x + 8 + wPill + 8;
    }

    const leftmostRightBtn = btns.filter(b => b.key !== "toggleLeft")[0]?.x ?? badge.x;
    const titleClipW = Math.max(30, leftmostRightBtn - 8 - leftOffset);
    return { btns, badge, titleX: leftOffset, titleClipW };
}

function railHeaderButtons(g) {
    if (g.folded) return [];
    ensureDockArrays(g);
    const ySub = g.y + HEADER_H;
    const btnY = ySub + 5;
    const btnH = SUB_HEADER_H - 10;
    const out = [];

    if (g.leftRailOpen !== false) {
        const lW = leftRailW(g);
        const toggleW = 22;
        const addW = Math.max(60, lW - toggleW - 16);
        out.push({
            key: "addGet",
            label: "+ Add GetNode",
            x: g.x + 6,
            y: btnY,
            w: addW,
            h: btnH,
        });
        out.push({
            key: "toggleLeft",
            label: "◀",
            title: "Ocultar painel GetNode",
            x: g.x + 6 + addW + 4,
            y: btnY,
            w: toggleW,
            h: btnH,
        });
    }

    if (g.rightRailOpen !== false) {
        const rW = rightRailW(g);
        const rx0 = g.x + g.w - rW;
        const toggleW = 22;
        const addW = Math.max(60, rW - toggleW - 16);
        out.push({
            key: "toggleRight",
            label: "▶",
            title: "Ocultar painel SetNode",
            x: rx0 + 6,
            y: btnY,
            w: toggleW,
            h: btnH,
        });
        out.push({
            key: "addSet",
            label: "+ Add SetNode",
            x: rx0 + 6 + toggleW + 4,
            y: btnY,
            w: addW,
            h: btnH,
        });
    }

    return out;
}

// ── Desenho no Canvas (onDrawBackground) ────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function roundRectTop(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
}

function drawOneEvmGroup(ctx, g) {
    ensureDockArrays(g);
    checkAndReflowGroupIfNeeded(g, curGraph());

    const tColor = gTitleColor(g);
    const bColor = gBodyColor(g);
    const tA = gTitleAlpha(g);
    const bA = gBodyAlpha(g);
    const fs = gFontSize(g);
    const hH = HEADER_H;
    const sel = _selectedIds.has(g.id);
    const scale = app.canvas?.ds?.scale || 1;
    const tInk = contrastInk(tColor);
    const layout = headerButtons(g);

    let running = false, runTitle = "", prog = null;
    if (g.folded && _runningNodeId != null && Array.isArray(g.foldNodes)) {
        const rid = String(_runningNodeId);
        let matchedId = null;
        for (const id of g.foldNodes) {
            const s = String(id);
            if (rid === s || rid.startsWith(s + ":")) { matchedId = s; break; }
        }
        if (matchedId != null) {
            running = true;
            const nodes = curGraph()?._nodes || [];
            const rn = nodes.find(n => String(n.id) === rid) || nodes.find(n => String(n.id) === matchedId);
            runTitle = (rn && (rn.title || rn.type)) || "Executando";
            if (_progress && _progress.max > 0 && String(_progress.node) === rid) {
                prog = Math.max(0, Math.min(1, _progress.value / _progress.max));
            }
        }
    }

    // 1. Corpo Principal (Sistema de Cores Padrão do ComfyUI — mesma cor do grupo com transparência suave)
    ctx.fillStyle = rgba(bColor, bA);
    roundRect(ctx, g.x, g.y, g.w, g.h, 8);
    ctx.fill();

    // 2. Trilhos Laterais (mesma família de cor do grupo, com leve contraste e linha divisória)
    if (!g.folded) {
        const ySub = g.y + hH;
        const bodyH = Math.max(0, g.h - hH);
        const lW = leftRailW(g);
        const rW = rightRailW(g);

        ctx.save();
        roundRect(ctx, g.x, g.y, g.w, g.h, 8);
        ctx.clip();

        // Trilho Esquerdo (GetNode)
        if (lW > 0) {
            ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
            ctx.fillRect(g.x, ySub, lW, bodyH);

            ctx.fillStyle = rgba(tColor, 0.18);
            ctx.fillRect(g.x, ySub, lW, SUB_HEADER_H);

            ctx.strokeStyle = rgba(tColor, 0.50);
            ctx.lineWidth = 1.5 / scale;
            ctx.beginPath();
            ctx.moveTo(g.x + lW, ySub);
            ctx.lineTo(g.x + lW, g.y + g.h);
            ctx.stroke();
        }

        // Trilho Direito (SetNode)
        if (rW > 0) {
            const rx0 = g.x + g.w - rW;
            ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
            ctx.fillRect(rx0, ySub, rW, bodyH);

            ctx.fillStyle = rgba(tColor, 0.18);
            ctx.fillRect(rx0, ySub, rW, SUB_HEADER_H);

            ctx.strokeStyle = rgba(tColor, 0.50);
            ctx.lineWidth = 1.5 / scale;
            ctx.beginPath();
            ctx.moveTo(rx0, ySub);
            ctx.lineTo(rx0, g.y + g.h);
            ctx.stroke();
        }

        // Linha abaixo do sub-header nos trilhos
        if (lW > 0 || rW > 0) {
            ctx.strokeStyle = rgba(tColor, 0.35);
            ctx.lineWidth = 1 / scale;
            if (lW > 0) {
                ctx.beginPath();
                ctx.moveTo(g.x, ySub + SUB_HEADER_H);
                ctx.lineTo(g.x + lW, ySub + SUB_HEADER_H);
                ctx.stroke();
            }
            if (rW > 0) {
                const rx0 = g.x + g.w - rW;
                ctx.beginPath();
                ctx.moveTo(rx0, ySub + SUB_HEADER_H);
                ctx.lineTo(g.x + g.w, ySub + SUB_HEADER_H);
                ctx.stroke();
            }
        }

        ctx.restore();

        // Botões dos trilhos (+ Add GetNode, ◀, ▶, + Add SetNode)
        const rBtns = railHeaderButtons(g);
        for (const rb of rBtns) {
            const isHot = _hotBtn && _hotBtn.gid === g.id && _hotBtn.key === rb.key;
            ctx.save();
            if (rb.key === "addGet" || rb.key === "addSet") {
                ctx.fillStyle = isHot ? rgba(tColor, 0.55) : rgba(tColor, 0.32);
            } else {
                ctx.fillStyle = isHot ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.25)";
            }
            roundRect(ctx, rb.x, rb.y, rb.w, rb.h, 5);
            ctx.fill();

            ctx.strokeStyle = isHot ? "rgba(255,255,255,0.50)" : rgba(tColor, 0.55);
            ctx.lineWidth = 1 / scale;
            roundRect(ctx, rb.x, rb.y, rb.w, rb.h, 5);
            ctx.stroke();

            ctx.fillStyle = "#ffffff";
            ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(rb.label, rb.x + rb.w / 2, rb.y + rb.h / 2 + 0.5);
            ctx.restore();
        }
    }

    // 3. Barra de Título Superior (30px = 3 quadradinhos)
    ctx.fillStyle = rgba(tColor, tA);
    roundRectTop(ctx, g.x, g.y, g.w, Math.min(hH, g.h), 8);
    ctx.fill();

    // 4. Borda Externa do Grupo
    ctx.strokeStyle = running ? RUN_GREEN : (sel ? SELECT_BORDER_COLOR : rgba(tColor, Math.max(0.55, tA)));
    ctx.lineWidth = (sel || running ? 2.4 : 1.4) / scale;
    roundRect(ctx, g.x, g.y, g.w, g.h, 8);
    ctx.stroke();

    // 5. Texto do Título
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.titleX, g.y, layout.titleClipW, hH);
    ctx.clip();
    ctx.fillStyle = running ? RUN_GREEN : tInk;
    ctx.font = `600 ${fs}px 'Segoe UI', system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const prefixIcon = running ? "▶ " : (g.pinned ? "📌 " : "");
    const titleStr = prefixIcon + (running ? runTitle : (g.title || "EVM Group"));
    ctx.fillText(titleStr, layout.titleX, g.y + hH / 2 + 0.5);
    ctx.restore();

    // 6. Badge de Contagem de Nós
    const bd = layout.badge;
    const count = g.folded
        ? (Array.isArray(g.foldNodes) ? g.foldNodes.length : 0)
        : groupMemberNodes(g).length;
    ctx.fillStyle = tInk === "#ffffff" ? "rgba(255,255,255,0.20)" : "rgba(0,0,0,0.18)";
    roundRect(ctx, bd.x, bd.y, bd.w, bd.h, 8);
    ctx.fill();
    ctx.fillStyle = tInk;
    ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count), bd.x + bd.w / 2, bd.y + bd.h / 2 + 0.5);

    // 7. Botões do Header (Run, Mute, Bypass, Fold/Unfold e Pílulas de Trilho Oculto)
    for (const b of layout.btns) {
        const hot = _hotBtn && _hotBtn.gid === g.id && _hotBtn.key === b.key;
        const light = tInk === "#ffffff";
        ctx.fillStyle = light
            ? (hot ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.16)")
            : (hot ? "rgba(0,0,0,0.30)" : "rgba(0,0,0,0.14)");
        roundRect(ctx, b.x, b.y, b.w, b.h, 4);
        ctx.fill();
        if (b.isTextPill) {
            ctx.fillStyle = tInk;
            ctx.font = "600 10.5px 'Segoe UI', system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
        } else {
            drawIcon(ctx, BTN_ICONS[b.key], b.x + (b.w - BICON) / 2, b.y + (b.h - BICON) / 2, BICON, tInk);
        }
    }

    // 8. Barra de Progresso se dobrado e executando
    if (prog != null) {
        ctx.fillStyle = RUN_GREEN;
        ctx.fillRect(g.x + 4, g.y + hH - 3, (g.w - 8) * prog, 2.5);
    }

    // 9. Handle de Redimensionamento no canto inferior direito
    if (!g.folded && !g.pinned) {
        ctx.fillStyle = rgba(tColor, sel ? 1 : 0.85);
        ctx.beginPath();
        ctx.moveTo(g.x + g.w, g.y + g.h - HANDLE_SIZE);
        ctx.lineTo(g.x + g.w, g.y + g.h - 8);
        ctx.arcTo(g.x + g.w, g.y + g.h, g.x + g.w - 8, g.y + g.h, 8);
        ctx.lineTo(g.x + g.w - HANDLE_SIZE, g.y + g.h);
        ctx.closePath();
        ctx.fill();
    }
}

function installDrawHook() {
    const c = app.canvas;
    if (!c) {
        setTimeout(installDrawHook, 150);
        return;
    }
    if (c._evmGroupBgWrapped) return;
    const prevFn = c.onDrawBackground;
    const prev = typeof prevFn === "function" ? (...a) => prevFn.apply(c, a) : null;

    c.onDrawBackground = function (ctx, area) {
        if (prev) {
            try { prev(ctx, area); } catch (_e) {}
        }
        try {
            // Se o usuário estiver fazendo multi-seleção por retângulo (marquee) no canvas,
            // atualiza a seleção de EVM Groups em tempo real enquanto o mouse passa sobre eles
            const dr = app.canvas?.dragging_rectangle;
            if (dr && dr.length >= 4) {
                updateMarqueeSelection(dr);
            }
            applyEvmNodeCarry();
            const gs = orderedEvmGroups();
            if (gs.length) {
                const { hiddenGroups } = hiddenMaps();
                const va = (area && area.length >= 4 && area[2] > 0 && area[3] > 0) ? area : null;
                ctx.save();
                for (const g of gs) {
                    if (hiddenGroups.has(String(g.id))) continue;
                    if (va && (g.x > va[0] + va[2] || g.x + g.w < va[0] || g.y > va[1] + va[3] || g.y + g.h < va[1])) continue;
                    drawOneEvmGroup(ctx, g);
                }
                ctx.restore();
            }
        } catch (_e) {}
    };
    c._evmGroupBgWrapped = true;
}

// ── Ações dos Botões (Run, Mute, Bypass, Fold) ──────────────────────────────
function isGroupOutputNode(n) {
    const NEVER = window.LiteGraph?.NEVER != null ? window.LiteGraph.NEVER : 2;
    return !!(n && n.mode !== NEVER && n.constructor?.nodeData?.output_node);
}

function queueEvmGroup(g) {
    const outs = groupMemberNodes(g).filter(isGroupOutputNode);
    if (!outs.length) {
        toast("Nenhum nó de saída neste grupo", "Coloque um nó Save ou Preview dentro do grupo para executar apenas ele.");
        return;
    }
    const ids = outs.map(n => String(n.id));
    try {
        const r = app.queuePrompt(0, 1, ids);
        if (r && typeof r.then === "function") r.catch(e => console.error("[EVM Group] Erro ao executar:", e));
    } catch (e) {
        console.error("[EVM Group] Erro ao executar:", e);
    }
}

function applyModeDeep(node, mode) {
    const stack = [node];
    while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        if (n.type === "SetNode" || n.type === "GetNode") continue;
        n.mode = mode;
        let inner = null;
        try {
            if (typeof n.isSubgraphNode === "function" && n.isSubgraphNode() && n.subgraph) {
                inner = n.subgraph.nodes || n.subgraph._nodes;
            }
        } catch (_e) {}
        if (inner && inner.length) {
            for (let i = inner.length - 1; i >= 0; i--) stack.push(inner[i]);
        }
    }
}

function toggleGroupMode(g, mode) {
    const ns = groupMemberNodes(g).filter(n => n.type !== "SetNode" && n.type !== "GetNode");
    if (!ns.length) return;
    const all = ns.every(n => n.mode === mode);
    const target = all ? 0 : mode;
    for (const n of ns) applyModeDeep(n, target);
    markChanged();
}

function runHeaderOrRailAction(g, key) {
    if (key === "run") queueEvmGroup(g);
    else if (key === "mute") toggleGroupMode(g, 2);
    else if (key === "bypass") toggleGroupMode(g, 4);
    else if (key === "fold") foldEvmGroup(g);
    else if (key === "unfold") unfoldEvmGroup(g);
    else if (key === "addGet") addDockedGetNode(g);
    else if (key === "addSet") addDockedSetNode(g);
    else if (key === "toggleLeft") toggleLeftRail(g);
    else if (key === "toggleRight") toggleRightRail(g);
}

// ── Criação, Exclusão e Conversão com Alinhamento Canônico (3 quadradinhos) ─
function createEvmGroup(p = null, options = {}) {
    const graph = curGraph();
    const gs = ensureEvmGroups(graph);
    const selNodes = app.canvas?.selected_nodes ? Object.values(app.canvas.selected_nodes).filter(Boolean) : [];
    const centralNodes = [];
    const initialGetIds = [];
    const initialSetIds = [];

    for (const n of selNodes) {
        if (n.type === "GetNode") {
            initialGetIds.push(n.id);
        } else if (n.type === "SetNode") {
            initialSetIds.push(n.id);
        } else {
            centralNodes.push(n);
        }
    }

    const lOpen = initialGetIds.length > 0 ? true : (options.leftRailOpen !== undefined ? options.leftRailOpen : EVM_CFG.defaultLeftOpen);
    const rOpen = initialSetIds.length > 0 ? true : (options.rightRailOpen !== undefined ? options.rightRailOpen : EVM_CFG.defaultRightOpen);
    const lRailW = DEFAULT_RAIL_W;
    const rRailW = DEFAULT_RAIL_W;
    const effLW = lOpen ? lRailW : 0;
    const effRW = rOpen ? rRailW : 0;
    let x, y, w, h;

    if (options.customBox) {
        x = snap(options.customBox.x);
        y = snap(options.customBox.y);
        w = snapUp(options.customBox.w);
        h = snapUp(options.customBox.h);
    } else if (centralNodes.length) {
        let minNodeX = Infinity;
        let minVisualY = Infinity;
        for (const n of centralNodes) {
            minNodeX = Math.min(minNodeX, n.pos[0]);
            minVisualY = Math.min(minVisualY, n.pos[1] - NODE_TITLE_H);
        }
        // Ancora a área central PAD à esquerda do 1º nó
        // e a base do cabeçalho (g.y + HEADER_H) PAD acima do topo visual do 1º nó!
        const centerX0 = snap(minNodeX) - PAD;
        x = centerX0 - effLW;
        y = snap(minVisualY) - PAD - HEADER_H;
        w = effLW + MIN_CENTER_W + effRW;
        h = MIN_GROUP_H;
    } else {
        x = snap(p ? p[0] : 120);
        y = snap(p ? p[1] : 120);
        w = effLW + 360 + effRW;
        h = 300;
    }

    const color = normalizeHex(options.color || options.titleColor || DEFAULT_GROUP_COLOR);
    const g = {
        id: newEvmGroupId(),
        title: options.title || "EVM Group",
        x,
        y,
        w,
        h,
        leftRailOpen: lOpen,
        rightRailOpen: rOpen,
        leftRailW: lRailW,
        rightRailW: rRailW,
        color,
        titleColor: color,
        bodyColor: color,
        fontSize: Number.isFinite(options.fontSize) ? options.fontSize : DEF_FONT_SIZE,
        getNodeIds: initialGetIds,
        setNodeIds: initialSetIds,
        _colorMigratedV2: true,
    };

    gs.push(g);

    for (const sid of initialSetIds) {
        const sn = graph?.getNodeById?.(sid);
        if (sn && (!sn.widgets?.[0]?.value || sn.widgets[0].value === "*")) {
            applyGroupNamingToSetNode(sn, g);
        }
    }

    // Organiza os nós centrais com margens e gaps de exatamente 3 quadradinhos (30px)
    if (centralNodes.length) {
        tidyGroupCentralNodes(g, graph, centralNodes);
    } else {
        layoutDockedNodes(g, graph, { shrinkHeightToFit: true });
    }

    selectEvmGroup(g);
    markChanged();
    return g;
}

function deleteEvmGroup(g) {
    if (!g) return;
    const gs = ensureEvmGroups();
    const idx = gs.indexOf(g);
    if (idx >= 0) gs.splice(idx, 1);
    _selectedIds.delete(g.id);
    if (_selectedId === g.id) _selectedId = null;
    invalidateHidden();
    updateHideCSS();
    markChanged();
}

/**
 * Converte um Pixaroma Group para EVM Group preservando título e cor padrão,
 * e aplicando o alinhamento de 3 quadradinhos (30px) aos nós internos.
 */
function convertPixaromaGroupToEvm(pixGroup) {
    const graph = curGraph();
    if (!graph || !pixGroup) return null;

    if (pixGroup.folded && pixGroup.hOpen) {
        pixGroup.folded = false;
        pixGroup.h = pixGroup.hOpen;
        pixGroup.w = pixGroup.wOpen || pixGroup.w;
    }

    const getIds = [];
    const setIds = [];
    const centralNodes = [];
    for (const n of (graph._nodes || [])) {
        if (!n || !n.pos) continue;
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (cx >= pixGroup.x && cx <= pixGroup.x + pixGroup.w && cy >= pixGroup.y && cy <= pixGroup.y + pixGroup.h) {
            if (n.type === "GetNode") getIds.push(n.id);
            else if (n.type === "SetNode") setIds.push(n.id);
            else centralNodes.push(n);
        }
    }

    const lW = DEFAULT_RAIL_W;
    const rW = DEFAULT_RAIL_W;
    const color = normalizeHex(pixGroup.color || pixGroup.titleColor || DEFAULT_GROUP_COLOR);

    const newG = {
        id: newEvmGroupId(),
        title: pixGroup.title || "EVM Group",
        x: snap(pixGroup.x - lW),
        y: snap(pixGroup.y),
        w: snapUp(Math.max(MIN_CENTER_W, pixGroup.w) + lW + rW),
        h: snapUp(Math.max(MIN_GROUP_H, pixGroup.h)),
        leftRailOpen: true,
        rightRailOpen: true,
        leftRailW: lW,
        rightRailW: rW,
        color,
        titleColor: color,
        bodyColor: color,
        fontSize: DEF_FONT_SIZE,
        getNodeIds: getIds,
        setNodeIds: setIds,
        _colorMigratedV2: true,
    };

    const pixArr = graph.extra?.pixaromaGroups;
    if (Array.isArray(pixArr)) {
        const i = pixArr.indexOf(pixGroup);
        if (i >= 0) pixArr.splice(i, 1);
    }

    ensureEvmGroups(graph).push(newG);
    if (centralNodes.length) {
        tidyGroupCentralNodes(newG, graph, centralNodes);
    } else {
        layoutDockedNodes(newG, graph, { shrinkHeightToFit: true });
    }
    selectEvmGroup(newG);
    markChanged();
    toast("Convertido para EVM Group", `Grupo "${newG.title}" organizado com margens de 3 quadradinhos.`);
    return newG;
}

/**
 * Converte um Grupo Nativo do ComfyUI (LGraphGroup) para EVM Group.
 */
function convertNativeGroupToEvm(natGrp) {
    const graph = curGraph();
    if (!graph || !natGrp) return null;
    const pos = natGrp._pos || natGrp.pos;
    const size = natGrp._size || natGrp.size;
    if (!pos || !size) return null;

    const bx = pos[0], by = pos[1], bw = size[0], bh = size[1];
    const getIds = [];
    const setIds = [];
    const centralNodes = [];
    for (const n of (graph._nodes || [])) {
        if (!n || !n.pos) continue;
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) {
            if (n.type === "GetNode") getIds.push(n.id);
            else if (n.type === "SetNode") setIds.push(n.id);
            else centralNodes.push(n);
        }
    }

    const lW = DEFAULT_RAIL_W;
    const rW = DEFAULT_RAIL_W;
    const color = normalizeHex(natGrp.color || DEFAULT_GROUP_COLOR);

    const newG = {
        id: newEvmGroupId(),
        title: natGrp.title || "EVM Group",
        x: snap(bx - lW),
        y: snap(by),
        w: snapUp(Math.max(MIN_CENTER_W, bw) + lW + rW),
        h: snapUp(Math.max(MIN_GROUP_H, bh)),
        leftRailOpen: true,
        rightRailOpen: true,
        leftRailW: lW,
        rightRailW: rW,
        color,
        titleColor: color,
        bodyColor: color,
        fontSize: DEF_FONT_SIZE,
        getNodeIds: getIds,
        setNodeIds: setIds,
        _colorMigratedV2: true,
    };

    try {
        if (typeof graph.remove === "function") graph.remove(natGrp);
        else {
            const arr = graph._groups || graph.groups;
            if (Array.isArray(arr)) {
                const i = arr.indexOf(natGrp);
                if (i >= 0) arr.splice(i, 1);
            }
        }
    } catch (_e) {}

    ensureEvmGroups(graph).push(newG);
    if (centralNodes.length) {
        tidyGroupCentralNodes(newG, graph, centralNodes);
    } else {
        layoutDockedNodes(newG, graph, { shrinkHeightToFit: true });
    }
    selectEvmGroup(newG);
    markChanged();
    toast("Convertido para EVM Group", `Grupo "${newG.title}" convertido e alinhado à grade.`);
    return newG;
}

// ── Interação de Mouse (Move, Resize, Multi-Seleção Marquee/Shift, Carry) ────
function nodeAtPoint(p) {
    const ns = curGraph()?._nodes || [];
    for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i];
        if (!n || !n.pos) continue;
        const b = nodeVisualBounds(n);
        if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) return n;
    }
    return null;
}

function clickIsOnSelectedNode(p) {
    const sel = app.canvas?.selected_nodes;
    if (!sel) return false;
    for (const k of Object.keys(sel)) {
        const n = sel[k];
        if (!n || !n.pos) continue;
        const b = nodeVisualBounds(n);
        if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) return true;
    }
    return false;
}

function nodeIsMemberOfGroup(g, n) {
    if (!g || !n || !n.pos) return false;
    ensureDockArrays(g);
    const nid = String(n.id);
    if (g.getNodeIds.some(id => String(id) === nid) || g.setNodeIds.some(id => String(id) === nid)) return true;
    const b = nodeVisualBounds(n);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h;
}

function nonMemberNodeAtHeader(g, p) {
    const n = nodeAtPoint(p);
    return !!(n && !nodeIsMemberOfGroup(g, n));
}

/**
 * Snapshot para carregar (carry) os EVM Groups co-selecionados quando o usuário
 * arrasta um nó que faz parte de uma multi-seleção (Nodes + EVM Groups).
 */
function snapshotEvmCarry() {
    if (!_selectedIds.size) return null;
    const selNodes = app.canvas?.selected_nodes ? Object.values(app.canvas.selected_nodes).filter(Boolean) : [];
    if (!selNodes.length) return null;
    const ref = selNodes.find(n => n && n.pos);
    if (!ref) return null;
    const selIds = new Set(selNodes.map(n => String(n.id)));
    const frames = [];
    const members = [];
    const fSet = new Set();
    const mSet = new Set();

    for (const g of getSelectedEvmGroups()) {
        if (g.pinned) continue;
        if (!fSet.has(g)) {
            fSet.add(g);
            frames.push({ g, x: g.x, y: g.y });
        }
        for (const ng of containedEvmGroups(g)) {
            if (!ng.pinned && !fSet.has(ng)) {
                fSet.add(ng);
                frames.push({ g: ng, x: ng.x, y: ng.y });
            }
        }
    }
    if (!frames.length) return null;

    for (const f of frames) {
        for (const n of groupMemberNodes(f.g)) {
            const sid = String(n.id);
            if (!selIds.has(sid) && !mSet.has(sid) && n.pos) {
                mSet.add(sid);
                members.push({ n, x: n.pos[0], y: n.pos[1] });
            }
        }
    }

    return {
        ref,
        rx: ref.pos[0],
        ry: ref.pos[1],
        rw: ref.size?.[0] || 0,
        rh: ref.size?.[1] || 0,
        frames,
        members,
    };
}

function applyEvmNodeCarry() {
    if (!_carry) return false;
    if (!_lmbDown || app.canvas?.resizing_node) {
        _carry = null;
        return false;
    }
    const ref = _carry.ref;
    if (!ref || !ref.pos) {
        _carry = null;
        return false;
    }
    // Se o tamanho do nó mudou, é um redimensionamento e não um arraste de posição
    if ((ref.size?.[0] || 0) !== _carry.rw || (ref.size?.[1] || 0) !== _carry.rh) {
        _carry = null;
        return false;
    }
    const dx = ref.pos[0] - _carry.rx;
    const dy = ref.pos[1] - _carry.ry;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;

    _clickDeselectPending = false;
    for (const f of _carry.frames) {
        f.g.x = snap(f.x + dx);
        f.g.y = snap(f.y + dy);
    }
    for (const m of _carry.members) {
        setNodePos(m.n, m.x + dx, m.y + dy);
    }
    return true;
}

/**
 * Atualiza em tempo real a seleção de EVM Groups durante o arraste do retângulo
 * de multi-seleção (marquee / dragging_rectangle) do ComfyUI.
 */
function updateMarqueeSelection(dr, shiftFlag) {
    if (!dr || dr.length < 4) return;
    _marqueeRect = [dr[0], dr[1], dr[2], dr[3]];
    if (typeof shiftFlag === "boolean") _marqueeShift = shiftFlag;
    if (!_preMarqueeSelectedIds) {
        _preMarqueeSelectedIds = _marqueeShift ? new Set(_selectedIds) : new Set();
    }

    const [mx, my, mw, mh] = _marqueeRect;
    const x0 = Math.min(mx, mx + mw), x1 = Math.max(mx, mx + mw);
    const y0 = Math.min(my, my + mh), y1 = Math.max(my, my + mh);
    if (x1 - x0 < 4 && y1 - y0 < 4) return;

    const nextIds = new Set(_preMarqueeSelectedIds);
    let lastHitId = null;

    for (const g of ensureEvmGroups()) {
        if (isHiddenGroup(g)) continue;
        const enclosesGroup = (g.x >= x0 && g.x + g.w <= x1 && g.y >= y0 && g.y + g.h <= y1);
        const hitsHeader = (x1 >= g.x && x0 <= g.x + g.w && y1 >= g.y && y0 <= g.y + HEADER_H);
        const startedOutsideGroup = !_marqueeStartPt || !inRect(g, _marqueeStartPt);
        const overlapsFromOutside = startedOutsideGroup && (x1 >= g.x && x0 <= g.x + g.w && y1 >= g.y && y0 <= g.y + g.h);

        if (enclosesGroup || hitsHeader || overlapsFromOutside) {
            nextIds.add(g.id);
            lastHitId = g.id;
        }
    }

    const changed = nextIds.size !== _selectedIds.size || [...nextIds].some(id => !_selectedIds.has(id));
    if (changed) {
        _selectedIds = nextIds;
        _selectedId = lastHitId || (_selectedIds.size ? [..._selectedIds][_selectedIds.size - 1] : null);
        repaint();
    }
}

function startWinDrag() {
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", onDragUp, true);
    window.addEventListener("pointercancel", onDragUp, true);
}

function stopWinDrag() {
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", onDragUp, true);
    window.removeEventListener("pointercancel", onDragUp, true);
}

function onPointerDown(e) {
    if (e.button !== 0) return;
    _lmbDown = true;
    _clickDeselectPending = false;
    _pendingEvmSelect = null;
    _pendingBodyAdditiveToggle = null;
    _marqueeRect = null;
    _marqueeShift = !!(e.shiftKey || e.ctrlKey || e.metaKey);
    _preMarqueeSelectedIds = _marqueeShift ? new Set(_selectedIds) : new Set();

    const c = app.canvas;
    if (!c) return;
    const onVueNode = isVueNodes() && e.target?.closest?.("[data-node-id]");
    if (e.target !== c.canvas && !onVueNode) return;
    if (onVueNode) {
        const t = e.target, tag = t && t.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON" ||
            t?.isContentEditable || t?.closest?.("input,select,textarea,button,[role='slider'],[contenteditable='true']")) return;
    }

    const p = screenToGraph(e.clientX, e.clientY);
    if (!p) return;
    _marqueeStartPt = p;

    const isAdditiveMod = !!(e.shiftKey || e.ctrlKey || e.metaKey);
    const gs = orderedEvmGroups();

    for (let i = gs.length - 1; i >= 0; i--) {
        const g = gs[i];
        if (isHiddenGroup(g)) continue;
        if (!inRect(g, p)) continue;

        // 1. Botões do Header Superior
        if (inHeader(g, p)) {
            const { btns } = headerButtons(g);
            for (const b of btns) {
                if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) {
                    if (!_selectedIds.has(g.id)) selectEvmGroup(g);
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    runHeaderOrRailAction(g, b.key);
                    repaint();
                    return;
                }
            }
        }

        // 2. Botões do Sub-Header dos Trilhos Laterais (+ Add GetNode, ◀, ▶, + Add SetNode)
        if (!g.folded) {
            const rBtns = railHeaderButtons(g);
            for (const rb of rBtns) {
                if (p[0] >= rb.x && p[0] <= rb.x + rb.w && p[1] >= rb.y && p[1] <= rb.y + rb.h) {
                    if (!_selectedIds.has(g.id)) selectEvmGroup(g);
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    runHeaderOrRailAction(g, rb.key);
                    repaint();
                    return;
                }
            }
        }

        // 3. Cantos de Redimensionamento
        const corner = cornerAt(g, p);
        if (corner && !nodeAtPoint(p)) {
            const ax = corner.includes("l") ? g.x + g.w : g.x;
            const ay = corner.includes("t") ? g.y + g.h : g.y;
            _drag = { mode: "resize", g, corner, ax, ay };
            selectEvmGroup(g);
            e.preventDefault();
            e.stopImmediatePropagation();
            startWinDrag();
            repaint();
            return;
        }

        // 4. Seleção / Multi-Seleção (Shift/Ctrl) e Arraste pelo Header, Sub-Header ou Trilhos Laterais
        const onNode = nodeAtPoint(p);
        const onGroupChrome = (inHeader(g, p) && !nonMemberNodeAtHeader(g, p)) ||
                              (inSubHeader(g, p) && !onNode) ||
                              (inRailArea(g, p) && !onNode);

        // Com Shift/Ctrl/Meta pressionado em qualquer área livre do grupo (header, painéis laterais Set/Get ou área central):
        // NÃO bloqueia o pointerdown para que o Ctrl+Drag inicie a caixa de seleção nativa (marquee) em qualquer lugar,
        // inclusive dentro dos painéis laterais! Se soltar sem arrastar (< 5px), alterna a seleção do grupo no pointerup.
        if (isAdditiveMod && !onNode) {
            _pendingBodyAdditiveToggle = { group: g, startX: e.clientX, startY: e.clientY };
            break;
        }

        if (onGroupChrome) {
            e.preventDefault();
            e.stopImmediatePropagation();

            if (!_selectedIds.has(g.id)) {
                selectEvmGroup(g);
            } else {
                // Já faz parte de uma multi-seleção (múltiplos grupos ou grupo + nós):
                // preserva toda a multi-seleção para arrastar tudo junto; se soltar sem arrastar, colapsa para só este grupo.
                _selectedId = g.id;
                _pendingEvmSelect = g.id;
            }

            if (g.pinned) {
                repaint();
                return;
            }

            const movedGroups = new Set();
            const movedNodes = new Map();
            for (const sg of getSelectedEvmGroups()) {
                if (sg.pinned) continue;
                movedGroups.add(sg);
                for (const ng of containedEvmGroups(sg)) {
                    if (!ng.pinned) movedGroups.add(ng);
                }
            }
            for (const mg of movedGroups) {
                for (const n of groupMemberNodes(mg)) movedNodes.set(String(n.id), n);
            }
            // Inclui também quaisquer nós nativos co-selecionados
            const nativeSel = app.canvas?.selected_nodes ? Object.values(app.canvas.selected_nodes) : [];
            for (const n of nativeSel) {
                if (n && n.pos && !movedNodes.has(String(n.id))) {
                    movedNodes.set(String(n.id), n);
                }
            }

            const groupStarts = [...movedGroups].map(gr => ({ gr, x: gr.x, y: gr.y }));
            const nodeStarts = [...movedNodes.values()].map(n => ({ n, x: n.pos[0], y: n.pos[1] }));
            _drag = { mode: "move", ox: p[0], oy: p[1], groupStarts, nodeStarts };
            startWinDrag();
            repaint();
            return;
        }
        break;
    }

    // Clique fora do cabeçalho/trilho do grupo (em um nó ou no fundo do canvas):
    // - Se Shift/Ctrl/Meta estiver pressionado: preserva os EVM Groups selecionados para que o nó clicado se junte à seleção!
    // - Se clicou sem Shift em um nó que já está selecionado junto com o(s) grupo(s): preserva para arrastar o conjunto (_carry).
    if (!isAdditiveMod && _selectedIds.size) {
        if (clickIsOnSelectedNode(p)) {
            _clickDeselectPending = true;
            _carry = snapshotEvmCarry();
        } else {
            _selectedId = null;
            _selectedIds.clear();
            repaint();
        }
    }
}

function onDragMove(e) {
    if (!_drag) return;
    const p = screenToGraph(e.clientX, e.clientY);
    if (!p) return;

    if (_drag.mode === "move") {
        let dx = p[0] - _drag.ox;
        let dy = p[1] - _drag.oy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            _pendingEvmSelect = null; // Arraste real -> mantém toda a multi-seleção
        }
        if (_drag.groupStarts.length) {
            const a = _drag.groupStarts[0];
            dx = snap(a.x + dx) - a.x;
            dy = snap(a.y + dy) - a.y;
        }
        for (const s of _drag.groupStarts) {
            s.gr.x = s.x + dx;
            s.gr.y = s.y + dy;
        }
        for (const s of _drag.nodeStarts) {
            setNodePos(s.n, s.x + dx, s.y + dy);
        }
    } else if (_drag.mode === "resize") {
        const g = _drag.g;
        const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };
        const c = _drag.corner, ax = _drag.ax, ay = _drag.ay;
        const cx = snap(p[0]);
        const cy = snap(p[1]);
        const minW = minGroupWidth(g);
        const w = Math.max(minW, c.includes("l") ? ax - cx : cx - ax);
        const h = Math.max(MIN_GROUP_H, c.includes("t") ? ay - cy : cy - ay);
        g.w = w;
        g.h = h;
        g.x = c.includes("l") ? ax - w : ax;
        g.y = c.includes("t") ? ay - h : ay;
        layoutDockedNodes(g, curGraph(), { prevBounds });
    }
    e.preventDefault();
    e.stopPropagation();
    repaint();
}

function onDragUp() {
    if (!_drag) return;
    const g = _drag.g;
    const dragMode = _drag.mode;
    const groupStarts = _drag.groupStarts;
    _drag = null;
    stopWinDrag();
    if (_pendingEvmSelect != null) {
        const gid = _pendingEvmSelect;
        _pendingEvmSelect = null;
        const targetG = ensureEvmGroups().find(x => x.id === gid);
        if (targetG) selectEvmGroup(targetG);
    }
    if (dragMode === "move" && Array.isArray(groupStarts) && groupStarts.length) {
        resolveGroupCollisionsOnMoveDrop(
            groupStarts.map(s => ({ gr: s.gr, startX: s.x, startY: s.y })),
            curGraph()
        );
    }
    if (g) layoutDockedNodes(g);
    repaint();
    markChanged();
}

function onGlobalPointerUp(e) {
    _lmbDown = false;
    const activeCarry = _carry;
    _carry = null;

    if (activeCarry && Array.isArray(activeCarry.frames) && activeCarry.frames.length) {
        resolveGroupCollisionsOnMoveDrop(
            activeCarry.frames.map(f => ({ gr: f.g, startX: f.x, startY: f.y })),
            curGraph()
        );
        repaint();
        markChanged();
    }

    if (_pendingBodyAdditiveToggle) {
        const pending = _pendingBodyAdditiveToggle;
        _pendingBodyAdditiveToggle = null;
        const dist = e ? Math.hypot((e.clientX ?? pending.startX) - pending.startX, (e.clientY ?? pending.startY) - pending.startY) : 0;
        const dr = app.canvas?.dragging_rectangle;
        const hadMarquee = _marqueeRect && (Math.abs(_marqueeRect[2]) >= 4 || Math.abs(_marqueeRect[3]) >= 4);
        const hasActiveDr = dr && dr.length >= 4 && (Math.abs(dr[2]) >= 4 || Math.abs(dr[3]) >= 4);
        if (dist < 5 && !hadMarquee && !hasActiveDr && pending.group) {
            toggleEvmGroupSelection(pending.group);
        }
    }

    if (_pendingEvmSelect != null) {
        const gid = _pendingEvmSelect;
        _pendingEvmSelect = null;
        const targetG = ensureEvmGroups().find(x => x.id === gid);
        if (targetG) selectEvmGroup(targetG);
    } else if (_clickDeselectPending) {
        _clickDeselectPending = false;
        if (_selectedIds.size) {
            _selectedIds.clear();
            _selectedId = null;
            repaint();
        }
    }

    // Finaliza multi-seleção por retângulo (marquee)
    if (_marqueeRect) {
        updateMarqueeSelection(_marqueeRect, _marqueeShift || !!(e && (e.shiftKey || e.ctrlKey || e.metaKey)));
        _marqueeRect = null;
        _marqueeStartPt = null;
        _marqueeShift = false;
        _preMarqueeSelectedIds = null;
    } else {
        _marqueeStartPt = null;
        _preMarqueeSelectedIds = null;
    }

    const graph = curGraph();
    if (!graph) return;
    const gs = ensureEvmGroups(graph);
    if (!gs.length) return;

    const selNodes = app.canvas?.selected_nodes ? Object.values(app.canvas.selected_nodes).filter(Boolean) : [];
    let changed = false;

    for (const n of selNodes) {
        if (n.type !== "GetNode" && n.type !== "SetNode") continue;
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const ownerInfo = findOwnerGroupForDockedNode(n);

        if (ownerInfo) {
            const og = ownerInfo.group;
            if (!inRect(og, [cx, cy])) {
                if (ownerInfo.side === "left") {
                    og.getNodeIds = og.getNodeIds.filter(id => String(id) !== String(n.id));
                } else {
                    og.setNodeIds = og.setNodeIds.filter(id => String(id) !== String(n.id));
                }
                layoutDockedNodes(og, graph, { shrinkHeightToFit: true });
                changed = true;
            } else {
                if (ownerInfo.side === "left") {
                    const nodes = resolveNodeList(graph, og.getNodeIds);
                    nodes.sort((a, b2) => a.pos[1] - b2.pos[1]);
                    og.getNodeIds = nodes.map(x => x.id);
                } else {
                    const nodes = resolveNodeList(graph, og.setNodeIds);
                    nodes.sort((a, b2) => a.pos[1] - b2.pos[1]);
                    og.setNodeIds = nodes.map(x => x.id);
                }
                layoutDockedNodes(og, graph, { shrinkHeightToFit: true });
                changed = true;
            }
        } else {
            const targetG = evmGroupAt([cx, cy]);
            if (targetG && !targetG.folded) {
                ensureDockArrays(targetG);
                const lW = leftRailW(targetG);
                const rW = rightRailW(targetG);
                if (n.type === "GetNode" && lW > 0 && cx <= targetG.x + lW + 25) {
                    targetG.getNodeIds.push(n.id);
                    layoutDockedNodes(targetG, graph, { shrinkHeightToFit: true });
                    changed = true;
                } else if (n.type === "SetNode" && rW > 0 && cx >= targetG.x + targetG.w - rW - 25) {
                    targetG.setNodeIds.push(n.id);
                    if (!n.widgets?.[0]?.value || n.widgets[0].value === "*") {
                        applyGroupNamingToSetNode(n, targetG);
                    }
                    layoutDockedNodes(targetG, graph, { shrinkHeightToFit: true });
                    changed = true;
                }
            }
        }
    }

    // Se nós centrais regulares foram movidos dentro de um EVM Group (ou soltos nele),
    // atualiza as bordas do grupo e empurra vizinhos caso o grupo tenha crescido
    if (!activeCarry && selNodes.length && !app.canvas?.resizing_node) {
        const groupsToRefresh = new Set();
        for (const n of selNodes) {
            if (!n || !n.pos || n.type === "GetNode" || n.type === "SetNode") continue;
            n._evmAlignedX = snap(n.pos[0]);
            n._evmAlignedY = snap(n.pos[1]);
            const b = nodeVisualBounds(n);
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            const prevGId = n._evmLastGroupId;
            const targetG = evmGroupAt([cx, cy]);
            if (targetG && !targetG.folded) {
                n._evmLastGroupId = targetG.id;
                groupsToRefresh.add(targetG);
            } else if (!targetG) {
                delete n._evmLastGroupId;
            }
            if (prevGId && (!targetG || prevGId !== targetG.id)) {
                const prevG = gs.find(og => og && og.id === prevGId);
                if (prevG && !prevG.folded) groupsToRefresh.add(prevG);
            }
        }
        for (const tg of groupsToRefresh) {
            layoutDockedNodes(tg, graph);
            changed = true;
        }
    }

    if (changed) {
        repaint();
        markChanged();
    }
}

let _cursorOverride = false;
function onHoverMove(e) {
    if (_drag) return;
    const el = app.canvas?.canvas;
    if (!el) return;
    const gs = ensureEvmGroups();
    if (!gs.length) {
        if (_cursorOverride) { el.style.cursor = ""; _cursorOverride = false; }
        return;
    }

    // Se o usuário estiver arrastando um retângulo de seleção (marquee), atualiza os grupos selecionados ao vivo
    const dr = app.canvas?.dragging_rectangle;
    if (dr && dr.length >= 4) {
        updateMarqueeSelection(dr, !!(e.shiftKey || e.ctrlKey || e.metaKey));
    }

    // Se o botão esquerdo está pressionado e há grupos selecionados sem _carry ainda, arma o snapshot de carry
    if ((e.buttons & 1) === 1 && !_carry && _selectedIds.size && !dr && !app.canvas?.resizing_node) {
        _carry = snapshotEvmCarry();
    }

    if (e.target !== el) {
        if (_cursorOverride) { el.style.cursor = ""; _cursorOverride = false; }
        return;
    }
    const p = screenToGraph(e.clientX, e.clientY);
    if (!p) return;

    let cur = null, hoverId = null, hotBtn = null;
    const ord = orderedEvmGroups();
    for (let i = ord.length - 1; i >= 0; i--) {
        const g = ord[i];
        if (isHiddenGroup(g) || !inRect(g, p)) continue;
        hoverId = g.id;

        if (inHeader(g, p)) {
            const { btns } = headerButtons(g);
            for (const b of btns) {
                if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) {
                    hotBtn = { gid: g.id, key: b.key };
                    break;
                }
            }
        }
        if (!hotBtn && !g.folded) {
            const rBtns = railHeaderButtons(g);
            for (const rb of rBtns) {
                if (p[0] >= rb.x && p[0] <= rb.x + rb.w && p[1] >= rb.y && p[1] <= rb.y + rb.h) {
                    hotBtn = { gid: g.id, key: rb.key };
                    break;
                }
            }
        }

        const corner = cornerAt(g, p);
        if (hotBtn) cur = "pointer";
        else if (corner && !nodeAtPoint(p)) cur = (corner === "tl" || corner === "br") ? "nwse-resize" : "nesw-resize";
        else if (!g.pinned && inHeader(g, p) && !nonMemberNodeAtHeader(g, p)) cur = "move";
        break;
    }

    if (cur) { el.style.cursor = cur; _cursorOverride = true; }
    else if (_cursorOverride) { el.style.cursor = ""; _cursorOverride = false; }

    const changed = hoverId !== _hoverId ||
        (hotBtn ? hotBtn.key : null) !== (_hotBtn ? _hotBtn.key : null) ||
        (hotBtn ? hotBtn.gid : null) !== (_hotBtn ? _hotBtn.gid : null);
    if (changed) {
        _hoverId = hoverId;
        _hotBtn = hotBtn;
        repaint();
    }
}

// ── Renomeação Inline (Duplo Clique no Header) ──────────────────────────────
function groupScreenRect(g) {
    const c = app.canvas, el = c?.canvas, ds = c?.ds;
    if (!el || !ds) return null;
    const r = el.getBoundingClientRect();
    const s = ds.scale || 1, o = ds.offset || [0, 0];
    const left = r.left + (g.x + o[0]) * s;
    const top = r.top + (g.y + o[1]) * s;
    return { left, top, width: g.w * s, height: g.h * s };
}

function inlineRenameEvmGroup(g) {
    const rect = groupScreenRect(g);
    if (!rect) return;
    const scale = app.canvas?.ds?.scale || 1;
    const oldTitle = g.title || "EVM Group";

    const inp = document.createElement("input");
    inp.value = oldTitle;
    inp.spellcheck = false;
    inp.style.cssText = `
        position: fixed; z-index: 100001; box-sizing: border-box;
        background: rgba(15, 23, 42, 0.96); border: 1.5px solid ${SELECT_BORDER_COLOR};
        border-radius: 5px; color: #fff; padding: 0 8px;
        font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 600; outline: none;
        left: ${rect.left + 10 * scale}px;
        top: ${rect.top + 3 * scale}px;
        width: ${Math.max(90, rect.width - 110 * scale)}px;
        height: ${Math.max(20, HEADER_H * scale - 6 * scale)}px;
        font-size: ${Math.max(12, Math.round(gFontSize(g) * scale))}px;
    `;
    document.body.appendChild(inp);
    inp.focus();
    inp.select();

    let done = false;
    const cleanup = () => {
        if (done) return;
        done = true;
        inp.removeEventListener("blur", commit);
        inp.remove();
    };
    const commit = () => {
        const nextTitle = inp.value.trim() || "EVM Group";
        g.title = nextTitle;
        syncDockedSetNodesOnGroupRename(g, oldTitle, nextTitle);
        markChanged();
        cleanup();
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("pointerdown", e => e.stopPropagation());
    inp.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cleanup(); }
    });
}

function onDblClick(e) {
    const c = app.canvas;
    if (!c || e.target !== c.canvas) return;
    const p = screenToGraph(e.clientX, e.clientY);
    if (!p) return;
    const gs = orderedEvmGroups();
    for (let i = gs.length - 1; i >= 0; i--) {
        const g = gs[i];
        if (isHiddenGroup(g)) continue;
        if (inHeader(g, p)) {
            const { btns } = headerButtons(g);
            for (const b of btns) {
                if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            inlineRenameEvmGroup(g);
            return;
        }
        if (inRect(g, p)) break;
    }
}

// ── Hooks em LGraphNode.prototype (collapse & onResize) e SetNode/GetNode ───
let _collapseHooked = false;
function installNodeCollapseAndResizeHooks() {
    if (_collapseHooked) return;
    const proto = window.LiteGraph?.LGraphNode?.prototype || app.graph?._nodes?.[0]?.constructor?.prototype;
    if (!proto || typeof proto.collapse !== "function") {
        setTimeout(installNodeCollapseAndResizeHooks, 250);
        return;
    }

    const origCollapse = proto.collapse;
    proto.collapse = function () {
        const res = origCollapse.apply(this, arguments);
        try {
            const graph = this.graph || curGraph();
            if (isGraphConfiguring(graph)) return res;
            const owner = findOwnerGroupForDockedNode(this);
            if (owner && owner.group) {
                layoutDockedNodes(owner.group, graph, { shrinkHeightToFit: true });
                markChanged();
            } else {
                // Verifica se é um nó central contido em algum EVM Group
                for (const g of ensureEvmGroups(graph)) {
                    if (g.folded) continue;
                    const cNodes = getCentralMemberNodes(g, graph);
                    if (cNodes.includes(this)) {
                        tidyGroupCentralNodes(g, graph, cNodes);
                        markChanged();
                        break;
                    }
                }
            }
        } catch (_e) {}
        return res;
    };

    const origOnResize = proto.onResize;
    proto.onResize = function (size) {
        const res = origOnResize ? origOnResize.apply(this, arguments) : undefined;
        try {
            const graph = this.graph || curGraph();
            if (isGraphConfiguring(graph)) return res;
            for (const g of ensureEvmGroups(graph)) {
                if (!g.folded) {
                    checkAndReflowGroupIfNeeded(g, graph);
                }
            }
        } catch (_e) {}
        return res;
    };

    _collapseHooked = true;
}

let _setNodeHooked = false;
function installSetNodeConnectionHook() {
    if (_setNodeHooked) return;
    const registered = window.LiteGraph?.registered_node_types;
    const SetNodeClass = registered?.["SetNode"];
    const GetNodeClass = registered?.["GetNode"];
    if (!SetNodeClass || !SetNodeClass.prototype) {
        setTimeout(installSetNodeConnectionHook, 300);
        return;
    }

    const origOnConn = SetNodeClass.prototype.onConnectionsChange;
    SetNodeClass.prototype.onConnectionsChange = function (slotType, slot, isChangeConnect, link_info) {
        const res = origOnConn?.apply(this, arguments);
        try {
            const graph = this.graph || curGraph();
            if (isGraphConfiguring(graph)) return res;
            const owner = findOwnerGroupForDockedNode(this);
            if (!app.configuringGraph && isChangeConnect && slotType === window.LiteGraph.INPUT) {
                if (owner && owner.side === "right") {
                    const detectedType = this.inputs?.[0]?.type || "OUT";
                    applyGroupNamingToSetNode(this, owner.group, detectedType);
                }
            }
            if (this.widgets?.[0]) {
                syncWidgetValue(this, 0, this.widgets[0].name || "Constant", this.widgets[0].value);
            }
            if (owner && owner.group) {
                layoutDockedNodes(owner.group, graph, { shrinkHeightToFit: true });
            }
        } catch (_e) {}
        return res;
    };

    if (GetNodeClass && GetNodeClass.prototype && !GetNodeClass.prototype._evmRenameHooked) {
        const origOnRename = GetNodeClass.prototype.onRename;
        GetNodeClass.prototype.onRename = function () {
            const r = origOnRename?.apply(this, arguments);
            try {
                const graph = this.graph || curGraph();
                if (isGraphConfiguring(graph)) return r;
                if (this.widgets?.[0]) {
                    syncWidgetValue(this, 0, this.widgets[0].name || "Constant", this.widgets[0].value);
                }
                const reqW = computeSetGetExpandedRequiredWidth(this);
                if (this.size) {
                    this.size[0] = reqW;
                    this._evmAutoW = reqW;
                }
                const owner = findOwnerGroupForDockedNode(this);
                if (owner && owner.group) {
                    layoutDockedNodes(owner.group, graph, { shrinkHeightToFit: true });
                }
            } catch (_e) {}
            return r;
        };
        GetNodeClass.prototype._evmRenameHooked = true;
    }

    _setNodeHooked = true;
}

// ── Persistência no Workflow (graph.extra.evmGroups) ────────────────────────
function wrapGraphPersistenceOnProto(G) {
    if (!G || G._evmGroupPersistWrapped) return;

    const origSerialize = G.serialize;
    G.serialize = function () {
        const data = origSerialize.apply(this, arguments);
        try {
            if (data) {
                const groups = this.extra && this.extra.evmGroups;
                if (Array.isArray(groups) && groups.length) {
                    if (!data.extra) data.extra = {};
                    data.extra.evmGroups = JSON.parse(JSON.stringify(groups));
                } else if (data.extra && "evmGroups" in data.extra) {
                    delete data.extra.evmGroups;
                }
            }
        } catch (_e) {}
        return data;
    };

    const origConfigure = G.configure;
    G.configure = function (data) {
        const savedGroups = Array.isArray(data?.extra?.evmGroups)
            ? JSON.parse(JSON.stringify(data.extra.evmGroups))
            : [];
        _evmConfiguring = true;
        this._evmConfiguring = true;
        let r;
        try {
            r = origConfigure.apply(this, arguments);
            if (!this.extra) this.extra = {};
            this.extra.evmGroups = savedGroups;
            for (const g of this.extra.evmGroups) {
                migrateLegacyColorsIfNeeded(g);
                ensureDockArrays(g);
            }
            for (const n of (this._nodes || [])) {
                if (n) delete n._evmLastGroupId;
            }
            for (const g of this.extra.evmGroups) {
                const cNodes = getCentralMemberNodes(g, this);
                syncGroupLayoutSignature(g, this, cNodes);
            }
            if (this === curGraph()) {
                invalidateHidden();
                updateHideCSS();
            }
        } catch (_e) {
        } finally {
            this._evmConfiguring = false;
            _evmConfiguring = false;
        }
        return r;
    };
    G._evmGroupPersistWrapped = true;
}

function installPersistence() {
    wrapGraphPersistenceOnProto(app.graph?.constructor?.prototype);
    wrapGraphPersistenceOnProto(window.LGraph?.prototype);
    const cg = curGraph();
    if (cg) wrapGraphPersistenceOnProto(cg.constructor?.prototype);
}

function installExecListeners() {
    if (!api || !api.addEventListener) return;
    const clear = () => { _runningNodeId = null; _progress = null; repaint(); };
    api.addEventListener("executing", e => {
        const d = e?.detail;
        _runningNodeId = d && typeof d === "object" ? d.node : d;
        if (_runningNodeId == null) _progress = null;
        repaint();
    });
    api.addEventListener("progress", e => {
        const d = e?.detail || {};
        const node = d.node != null ? d.node : _runningNodeId;
        _progress = { value: Number(d.value) || 0, max: Number(d.max) || 0, node };
        repaint();
    });
    api.addEventListener("execution_start", clear);
    api.addEventListener("execution_success", clear);
    api.addEventListener("execution_error", clear);
    api.addEventListener("execution_interrupted", clear);
}

function toast(summary, detail) {
    try {
        const t = app.extensionManager?.toast;
        if (t?.add) {
            t.add({ severity: "info", summary, detail, life: 3500 });
            return;
        }
    } catch (_e) {}
    try {
        const el = document.createElement("div");
        el.textContent = detail ? `${summary} — ${detail}` : summary;
        el.style.cssText = `
            position:fixed;bottom:24px;right:24px;z-index:100000;
            background:#18181b;color:#e0f2fe;border:1px solid ${SELECT_BORDER_COLOR};
            border-radius:8px;padding:10px 16px;font:600 13px 'Segoe UI',sans-serif;
            box-shadow:0 8px 24px rgba(0,0,0,0.6);
        `;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3200);
    } catch (_e) {}
}

// ── Organizador Nativo 100% JavaScript (Padrão Dj Edu — Zero Dependência Externa) ──
const _organizeUndoStack = [];
let _organizeBusy = false;

const WF_STAGES = [
    "NOTES",
    "MODELS",
    "INPUT",
    "PROMPT",
    "PROMPT_EXPANSION",
    "SETTINGS",
    "CONDITION",
    "SAMPLING",
    "REFINE",
    "UPSCALE",
    "OUTPUT",
];
const WF_AUX = "AUX";
const WF_OTHER = "OTHER";

const WF_PALETTE = {
    NOTES:            { group: "#000000", node: "#222222", bg: "#000000" },
    MODELS:           { group: "#613583", node: "#481c6a", bg: "#613583" },
    INPUT:            { group: "#8888aa", node: "#223",    bg: "#335" },
    PROMPT:           { group: "#2b652b", node: "#124c12", bg: "#2b652b" },
    PROMPT_EXPANSION: { group: "#189164", node: "#189164", bg: "#22342e" },
    SETTINGS:         { group: "#3f789e", node: "#1b4669", bg: "#29699c" },
    CONDITION:        { group: "#cfa62a", node: "#cfa62a", bg: "#3e3825" },
    SAMPLING:         { group: "#3c3c83", node: "#23236a", bg: "#3c3c83" },
    REFINE:           { group: "#248382", node: "#0b6a69", bg: "#248382" },
    UPSCALE:          { group: "#246283", node: "#0b496a", bg: "#246283" },
    OUTPUT:           { group: "#631e1e", node: "#4a0505", bg: "#631e1e" },
    AUX:              { group: "#444444", node: null,      bg: null },
    OTHER:            { group: "#3f789e", node: "#1b4669", bg: "#29699c" },
};
const WF_AUDIO_GROUP_COLOR = "#ffffff";

const WF_ADOPT_TITLES = {
    NOTES: "Notes",
    MODELS: "Models",
    INPUT: "Input",
    PROMPT: "Prompt",
    PROMPT_EXPANSION: "Prompt Expansion",
    SETTINGS: "Size - Seed - Steps",
    CONDITION: "Condition",
    SAMPLING: "Sampling",
    REFINE: "Refine",
    UPSCALE: "Upscale",
    OUTPUT: "Output",
    OTHER: "Outros",
};

const WF_GROUP_RULES = [
    ["NOTES",            /\bnotas?\b|\bnotes?\b|markdown\s*notes?|note\s*plus|pixaroma\s*note|\binfo(rma[çc][õo]es)?\b|instru[çc][õo]es|instructions?|readme|how\s*to(\s*use)?|como\s*usar|documenta[çc][ãa]o|documentation/i],
    ["UPSCALE",          /upscal|seedvr|interpolat|latent upscale/i],
    ["OUTPUT",           /output|save|export|render|combine|merge|composite|montagem|aplica|t[ií]tulo|\bnome\b|logo|stitch|overlay|watermark|\bcta\b/i],
    ["PROMPT_EXPANSION", /prompt expansion|expans[ãa]o de prompt/i],
    ["PROMPT",           /^\s*(\d+[\.\-\s]*)?prompt\b|prompt\s*\(|prompt generation|text encode/i],
    ["CONDITION",        /condition\b|conditioning/i],
    ["REFINE",           /detailer|refine|\bface\b|hand|mouth|\beye|foot|fidelity|\bnag\b|remove background|background/i],
    ["SAMPLING",         /sampl|decod|guider|noise|scheduler|sigmas|latent|generate|first pass|second pass|\bpass\b|1st pass|2nd pass/i],
    ["MODELS",           /model|loader|load models?|lora|\bclip\b|\bvae\b|checkpoint|unet|attention|patch|gguf|\bdit\b|zimage|krea|qwen image|load early/i],
    ["PROMPT",           /prompt|instruction|enhanc|style|lyrics|texto|\btext\b/i],
    ["SETTINGS",         /\bsizes?\b|resolution|\bseed\b|steps|length|lenght|setting|options|aspect|empty latent|frames|dura[çc][ãa]o/i],
    ["INPUT",            /input|reference|\bref\b|imagem|image|carrega|frames|audio|voice|voz|music|custom audio|guides|controlnet|personagem|g[eê]nero|thumbnail|capa|foto/i],
    ["AUX",              /fast groups|bypass|clear (mem|ram)|memory|performance|timer|compare|settings? da|seletor geral|number conversion|utility|debug|\bstats\b/i],
];

const WF_NODE_RULES = [
    ["NOTES",    /^(Note|MarkdownNote|Note Plus \(mtb\)|PixaromaNote|NoteNode)$|Markdown\s*Note/i],
    ["UPSCALE",  /SeedVR2|Upscal|RTXVideoSuperResolution|LatentUpscal/i],
    ["MODELS",   /Loader|Lora|Attention|ModelSampling|CFGNorm|ModelPatch|CheckpointLoader|Power Lora/i],
    ["REFINE",   /Detailer|H3Face|H3PerFrame|SAMLoader|UltralyticsDetector/i],
    ["PROMPT",   /CLIPTextEncode|TextEncode|TextGenerate|FluxGuidance|ConditioningZeroOut|ConditioningCombine|ConditioningSet|StringConcatenate|ttN text|ShowText|TextPreview|PrimitiveString/i],
    ["SETTINGS", /Resolution|Aspect|Output Options|Empty.*Latent|RandomNoise|Scheduler|Sigmas|INTConstant|PrimitiveInt|PrimitiveFloat|PrimitiveBoolean|ttN seed|Calculator|ComfyMathExpression|GetImageSize/i],
    ["SAMPLING", /KSampler|Sampler|Guider|VAEDecode|VAEEncode|SeparateAVLatent|ConcatAVLatent|ImgToVideoInplace|ImageToVideo|ReferenceToVideo|GenerateMusic|GenerateABC|AudioVAE/i],
    ["OUTPUT",   /Save|Preview|Image Save|FlowSave|Comparer|Compos|Overlay Text|ConcatMulti|MaskPreview|CreateVideo|VideoCombine/i],
    ["INPUT",    /LoadImage|LoadAudio|LoadVideo|LoadVideoUpload|ImageScale|ResizeImage|ResizeImages|ReferenceLatent|CropGuides|SetLatentNoiseMask|ImageStitch|SolidMask|TrimAudio|Voice|TTS|VibeVoice|GetVideoComponents/i],
];

const WF_HELPER_TYPES = new Set([
    "Fast Groups Bypasser (rgthree)",
    "Reroute",
    "Reroute (rgthree)",
    "Label (rgthree)",
    "PrimitiveNode",
    "Anything Everywhere",
    "PixaromaMonitor",
    "PixaromaRunTimer",
]);

const WF_MODEL_LOADER_TYPES = new Set([
    "VAELoader", "VAELoaderKJ", "CLIPLoader", "CLIPLoaderGGUF", "UNETLoader",
    "UnetLoaderGGUF", "DualCLIPLoader", "DualCLIPLoaderGGUF",
    "CheckpointLoaderSimple", "LoraLoaderModelOnly", "LoraLoaderAdvanced",
    "NunchakuQwenImageDiTLoader", "NunchakuFluxDiTLoader", "NunchakuZImageDiTLoader",
    "DiffusionModelLoaderKJ", "Qwen3Loader", "AudioEncoderLoader",
    "UpscaleModelLoader", "ControlNetLoader", "MelBandRoFormerModelLoader",
    "ModelAttentionBackend", "PathchSageAttentionKJ", "SpectrumApplyMiniMaxH3",
]);

const WF_PREVIEW_OR_MULTILINE_TYPES = new Set([
    "LoadImage", "LoadImageMask", "SaveImage", "PreviewImage", "SaveVideo",
    "VHS_VideoCombine", "VHS_LoadVideo", "VHS_LoadVideoPath", "VHS_LoadAudioUpload",
    "VHS_LoadAudio", "LoadAudio", "PreviewAudio", "SaveAudio",
    "Image Comparer (rgthree)", "PrimitiveStringMultiline",
    "CLIPTextEncode", "CLIPTextEncodeFlux", "CLIPTextEncodeSDXL",
    "Note", "MarkdownNote", "Note Plus (mtb)", "PixaromaNote", "MiniMaxH3ReferenceToVideo",
]);

const WF_PASSTHROUGH_CLEAN_TYPES = new Set([
    "UnloadAllModels",
    "easy cleanGpuUsed",
    "VRAM_Debug",
    "FreeU",
]);

function wfStageFromText(text) {
    if (!text) return WF_OTHER;
    const s = String(text);
    for (const [name, rx] of WF_GROUP_RULES) {
        if (rx.test(s)) return name;
    }
    return WF_OTHER;
}

function wfStageFromNodeType(nodeType) {
    if (!nodeType) return WF_OTHER;
    const t = String(nodeType);
    if (WF_HELPER_TYPES.has(t)) return WF_AUX;
    if (WF_MODEL_LOADER_TYPES.has(t)) return "MODELS";
    for (const [name, rx] of WF_NODE_RULES) {
        if (rx.test(t)) return name;
    }
    return WF_OTHER;
}

function wfStageFromNode(node) {
    if (!node || typeof node !== "object") return WF_OTHER;
    const st = wfStageFromNodeType(node.type);
    if (st !== WF_OTHER) return st;
    if (node.title) {
        const stTitle = wfStageFromText(node.title);
        if (stTitle !== WF_OTHER) return stTitle;
    }
    return WF_OTHER;
}

function wfNodeSize(node) {
    const sz = node?.size;
    if (Array.isArray(sz) && sz.length >= 2) {
        return [Number(sz[0]) || 210, Number(sz[1]) || 60];
    }
    if (sz && typeof sz === "object") {
        return [Number(sz["0"] ?? sz.width ?? 210), Number(sz["1"] ?? sz.height ?? 60)];
    }
    return [210, 60];
}

function wfIsCollapsed(node) {
    return Boolean(node?.flags?.collapsed);
}

function wfNodeBox(node) {
    const pos = node?.pos || [0, 0];
    const [w, h] = wfNodeSize(node);
    return [Number(pos[0]) || 0, Number(pos[1]) || 0, w, wfIsCollapsed(node) ? 0 : h];
}

function wfGetSetKey(node) {
    if (!node || (node.type !== "SetNode" && node.type !== "GetNode")) return "";
    const wvn = node.widgets_values_named;
    if (wvn && typeof wvn === "object" && wvn.Constant) return String(wvn.Constant);
    const wv = node.widgets_values;
    if (Array.isArray(wv) && wv.length && wv[0]) return String(wv[0]);
    if (wv && typeof wv === "object") {
        const firstVal = Object.values(wv)[0];
        if (firstVal) return String(firstVal);
    }
    return "";
}

function measureTextWidth(text, font = "bold 14px Arial, sans-serif") {
    try {
        const ctx = getMeasCtx();
        if (ctx) {
            ctx.font = font;
            return ctx.measureText(String(text || "")).width;
        }
    } catch (_e) {}
    return String(text || "").length * 8.5;
}

function wfDockedNodeExpandedWidth(node) {
    const title = String(node?.title || node?.type || "");
    const titleW = Math.max(
        measureTextWidth(title, "600 14px Inter, Arial, sans-serif"),
        measureTextWidth(title, "bold 14px Arial, sans-serif")
    );
    const titleReq = Math.ceil(titleW + NODE_TITLE_H * 2 + 12);
    const wval = wfGetSetKey(node);
    const nameW = measureTextWidth("Constant", "14px Arial, sans-serif");
    const valW = measureTextWidth(wval, "14px Arial, sans-serif");
    const widgetReq = Math.ceil(nameW + valW + 76);
    const compW = Math.max(210, titleW + 40);
    return snapUp(Math.max(MIN_RAIL_INNER_W, titleReq, widgetReq, compW));
}

function wfDockedNodeWidth(node) {
    const title = String(node?.title || node?.type || "");
    if (wfIsCollapsed(node)) {
        const collapsedReq = Math.ceil(measureTextWidth(title, "bold 14px Arial, sans-serif") + NODE_TITLE_H * 2);
        return snapUp(Math.max(MIN_RAIL_INNER_W, collapsedReq));
    }
    const [w] = wfNodeSize(node);
    const expReq = wfDockedNodeExpandedWidth(node);
    return snapUp(Math.max(MIN_RAIL_INNER_W, w, expReq));
}

function wfComputeMinNodeHeight(node) {
    const ntype = String(node?.type || "");
    if (ntype === "SetNode" || ntype === "GetNode") return 60;
    const [, curH] = wfNodeSize(node);
    if (ntype === "LoadImage") {
        return curH >= 300 ? 340 : snapUp(curH);
    }
    if (WF_PREVIEW_OR_MULTILINE_TYPES.has(ntype) || ntype.includes("Preview") || ntype.includes("Multiline")) {
        return snapUp(curH);
    }
    const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
    const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
    const nonWidgetInputs = inputs.filter(inp => !inp || typeof inp !== "object" || !("widget" in inp)).length;
    const widgetInputs = inputs.filter(inp => inp && typeof inp === "object" && "widget" in inp).length;
    const slotRows = Math.max(nonWidgetInputs, outputs.length, 1);

    const wv = node?.widgets_values;
    let numWidgets = 0;
    if (Array.isArray(wv)) {
        numWidgets = wv.length;
    } else if (wv && typeof wv === "object") {
        numWidgets = Object.keys(wv).filter(k => k !== "videopreview").length;
    }
    numWidgets = Math.max(numWidgets, widgetInputs);
    const widgetsH = numWidgets > 0 ? (numWidgets * 24 + 8) : 0;
    const rawH = slotRows * 20 + widgetsH + 6;
    return snapUp(Math.max(30, rawH));
}

function wfIsEvmGroup(g) {
    if (!g || typeof g !== "object") return false;
    return (
        "leftRailW" in g ||
        "rightRailW" in g ||
        "getNodeIds" in g ||
        "setNodeIds" in g ||
        String(g.id || "").startsWith("evmg_")
    );
}

function wfGroupBox(g) {
    if (Array.isArray(g?.bounding) && g.bounding.length >= 4) {
        return [Number(g.bounding[0]) || 0, Number(g.bounding[1]) || 0, Number(g.bounding[2]) || 0, Number(g.bounding[3]) || 0];
    }
    return [Number(g?.x) || 0, Number(g?.y) || 0, Number(g?.w) || 0, Number(g?.h) || 0];
}

function wfHasAudioHint(group, nodes) {
    const text = String(group?.title || "").toLowerCase();
    if (/audio|voz|voice|music|som|trilha|tts|lyrics|logo|capa|thumbnail|fundo|marca|asset/.test(text)) {
        return true;
    }
    const markers = ["Audio", "Voz", "Voice", "TTS", "Music"];
    return (nodes || []).some(n => markers.some(m => String(n?.type || "").includes(m)));
}

function wfGroupColorFor(stage, _group, _nodes) {
    const raw = (WF_PALETTE[stage] || WF_PALETTE.OTHER).group || "#3f789e";
    return normalizeHex(raw, "#3f789e");
}

function wfGetGroups(data) {
    if (data?.extra && typeof data.extra === "object") {
        if (Array.isArray(data.extra.evmGroups) && data.extra.evmGroups.length) return data.extra.evmGroups;
        if (Array.isArray(data.extra.pixaromaGroups) && data.extra.pixaromaGroups.length) return data.extra.pixaromaGroups;
    }
    if (Array.isArray(data?.groups) && data.groups.length) return data.groups;
    if (!data.extra || typeof data.extra !== "object") data.extra = {};
    if (!Array.isArray(data.extra.evmGroups)) data.extra.evmGroups = [];
    return data.extra.evmGroups;
}

function wfContainsPoint(box, x, y) {
    const [bx, by, bw, bh] = box;
    return bx <= x && x <= bx + bw && by <= y && y <= by + bh;
}

function wfMembersOf(data, group) {
    const box = wfGroupBox(group);
    const gStage = wfStageFromText(group?.title);
    const dockedIds = new Set();
    const allDockedElsewhere = new Set();

    for (const nid of (group?.getNodeIds || [])) dockedIds.add(String(nid));
    for (const nid of (group?.setNodeIds || [])) dockedIds.add(String(nid));

    for (const gOther of wfGetGroups(data)) {
        if (gOther === group) continue;
        for (const nid of (gOther?.getNodeIds || [])) allDockedElsewhere.add(String(nid));
        for (const nid of (gOther?.setNodeIds || [])) allDockedElsewhere.add(String(nid));
    }

    const byId = new Map((data.nodes || []).map(n => [Number(n.id), n]));
    const revAdj = new Map();
    for (const lk of (data.links || [])) {
        if (Array.isArray(lk) && lk.length >= 4) {
            const src = Number(lk[1]);
            const dst = Number(lk[3]);
            if (!revAdj.has(dst)) revAdj.set(dst, []);
            revAdj.get(dst).push(src);
        }
    }

    const isExternalStageNode = (node, visited = new Set()) => {
        const nid = Number(node?.id);
        if (visited.has(nid)) return false;
        visited.add(nid);
        const ntStage = wfStageFromNodeType(node?.type);
        const ttStage = wfStageFromText(node?.title);
        if (
            ntStage === WF_OTHER &&
            ttStage !== WF_OTHER &&
            ttStage !== WF_AUX &&
            ttStage !== gStage &&
            /face refine|face detailer/i.test(String(node?.title || ""))
        ) {
            return true;
        }
        if (WF_PASSTHROUGH_CLEAN_TYPES.has(String(node?.type))) {
            for (const upId of (revAdj.get(nid) || [])) {
                const upN = byId.get(upId);
                if (upN && isExternalStageNode(upN, visited)) return true;
            }
        }
        return false;
    };

    const out = [];
    for (const n of (data.nodes || [])) {
        const nidStr = String(n.id);
        if (dockedIds.has(nidStr)) {
            out.push(n);
            continue;
        }
        if (allDockedElsewhere.has(nidStr)) continue;
        const pos = n.pos || [0, 0];
        if (wfContainsPoint(box, Number(pos[0]) || 0, Number(pos[1]) || 0)) {
            if (isExternalStageNode(n)) continue;
            out.push(n);
        }
    }
    return out;
}

function wfClassifyGroup(data, group) {
    const members = wfMembersOf(data, group);
    const byTitle = wfStageFromText(group?.title);

    if (members.length) {
        const central = members.filter(n => n.type !== "GetNode" && n.type !== "SetNode");
        const pool = central.length ? central : members;
        const loaderCount = pool.filter(n => wfStageFromNodeType(n.type) === "MODELS").length;
        if (
            loaderCount / pool.length >= 0.7 &&
            [WF_OTHER, "MODELS", "SAMPLING", "PROMPT", "SETTINGS", "REFINE"].includes(byTitle)
        ) {
            return "MODELS";
        }
        if (
            byTitle === "MODELS" &&
            pool.every(n => ["INPUT", "OUTPUT", WF_AUX].includes(wfStageFromNodeType(n.type)))
        ) {
            return "INPUT";
        }
    }
    if (byTitle !== WF_OTHER) return byTitle;

    const votes = new Map();
    for (const n of members) {
        const st = wfStageFromNodeType(n.type);
        if (st !== WF_OTHER && st !== WF_AUX) {
            votes.set(st, (votes.get(st) || 0) + 1);
        }
    }
    let bestStage = WF_OTHER;
    let bestCount = 0;
    for (const [st, cnt] of votes.entries()) {
        if (cnt > bestCount) {
            bestCount = cnt;
            bestStage = st;
        }
    }
    return bestStage;
}

function wfConvertGroupToEvm(group, stage = WF_OTHER, index = 1, nodes = []) {
    const [x, y, w, h] = wfGroupBox(group);
    const rawColor = wfGroupColorFor(stage, group, nodes);
    const color = normalizeHex(rawColor || group?.color || group?.titleColor || "#3f789e");
    const gid = group?.id;
    const evmId = (typeof gid === "string" && gid.startsWith("evmg_"))
        ? gid
        : `evmg_${stage.toLowerCase()}_${index}`;

    const getIds = (group?.getNodeIds || []).map(nid => (/^\d+$/.test(String(nid)) ? Number(nid) : nid));
    const setIds = (group?.setNodeIds || []).map(nid => (/^\d+$/.test(String(nid)) ? Number(nid) : nid));
    const leftOpen = getIds.length ? true : Boolean(group?.leftRailOpen ?? true);
    const rightOpen = setIds.length ? true : Boolean(group?.rightRailOpen ?? true);
    const leftW = snapUp(Math.max(DEFAULT_RAIL_W, Number(group?.leftRailW) || DEFAULT_RAIL_W));
    const rightW = snapUp(Math.max(DEFAULT_RAIL_W, Number(group?.rightRailW) || DEFAULT_RAIL_W));

    const evmGroup = {
        id: evmId,
        title: group?.title || "",
        x: snap(x),
        y: snap(y),
        w: snapUp(w),
        h: snapUp(h),
        leftRailOpen: leftOpen,
        rightRailOpen: rightOpen,
        leftRailW: leftW,
        rightRailW: rightW,
        color,
        titleColor: color,
        bodyColor: color,
        fontSize: (group?.fontSize === 14 || group?.fontSize === 16) ? Number(group.fontSize) : DEF_FONT_SIZE,
        getNodeIds: getIds,
        setNodeIds: setIds,
        _colorMigratedV2: true,
    };
    for (const k of ["folded", "showLinks", "hOpen", "wOpen", "foldNodes", "foldGroups", "pinned"]) {
        if (group && k in group) evmGroup[k] = group[k];
    }
    return evmGroup;
}

function wfEnsureEvmGroups(data) {
    if (!data.extra || typeof data.extra !== "object") data.extra = {};
    if (!Array.isArray(data.extra.evmGroups)) data.extra.evmGroups = [];
    const evmGroups = data.extra.evmGroups;
    const coreGroups = Array.isArray(data.groups) ? data.groups : [];
    const pixGroups = Array.isArray(data.extra.pixaromaGroups) ? data.extra.pixaromaGroups : [];

    const existingTitles = new Set(evmGroups.map(g => g?.title).filter(Boolean));
    const existingIds = new Set(evmGroups.map(g => g?.id).filter(Boolean));
    let convertedCount = 0;

    for (const srcList of [pixGroups, coreGroups]) {
        for (const g of srcList) {
            if (!g || typeof g !== "object") continue;
            if (wfIsEvmGroup(g)) {
                if (!existingIds.has(g.id) && !existingTitles.has(g.title)) {
                    evmGroups.push(g);
                    if (g.id) existingIds.add(g.id);
                    if (g.title) existingTitles.add(g.title);
                }
                continue;
            }
            if (g.title && existingTitles.has(g.title)) continue;
            const members = wfMembersOf(data, g);
            const stage = wfClassifyGroup(data, g);
            let idx = evmGroups.length + 1;
            const evmG = wfConvertGroupToEvm(g, stage, idx, members);
            while (existingIds.has(evmG.id)) {
                idx += 1;
                evmG.id = `evmg_${stage.toLowerCase()}_${idx}`;
            }
            evmGroups.push(evmG);
            existingIds.add(evmG.id);
            if (evmG.title) existingTitles.add(evmG.title);
            convertedCount += 1;
        }
    }
    data.groups = [];
    delete data.extra.pixaromaGroups;
    return convertedCount;
}

function wfSetGroups(data, groups) {
    if (!data.extra || typeof data.extra !== "object") data.extra = {};
    const evmGroups = [];
    groups.forEach((g, i) => {
        if (wfIsEvmGroup(g)) {
            delete g.bounding;
            delete g.flags;
            delete g.titleAlpha;
            delete g.bodyAlpha;
            evmGroups.push(g);
        } else {
            const stage = wfClassifyGroup(data, g);
            const members = wfMembersOf(data, g);
            evmGroups.push(wfConvertGroupToEvm(g, stage, i + 1, members));
        }
    });
    data.extra.evmGroups = evmGroups;
    delete data.extra.pixaromaGroups;
    data.groups = [];
}

function wfLinkAdjacency(data) {
    const adjacency = new Map();
    const addEdge = (u, v) => {
        if (!adjacency.has(u)) adjacency.set(u, []);
        adjacency.get(u).push(v);
    };
    for (const link of (data.links || [])) {
        if (Array.isArray(link) && link.length >= 4) {
            const u = Number(link[1]);
            const v = Number(link[3]);
            if (Number.isFinite(u) && Number.isFinite(v)) addEdge(u, v);
        }
    }
    const setsByKey = new Map();
    const getsByKey = new Map();
    for (const n of (data.nodes || [])) {
        const key = wfGetSetKey(n);
        if (!key) continue;
        if (n.type === "SetNode") {
            if (!setsByKey.has(key)) setsByKey.set(key, []);
            setsByKey.get(key).push(Number(n.id));
        } else if (n.type === "GetNode") {
            if (!getsByKey.has(key)) getsByKey.set(key, []);
            getsByKey.get(key).push(Number(n.id));
        }
    }
    for (const [key, sIds] of setsByKey.entries()) {
        const gIds = getsByKey.get(key) || [];
        for (const sId of sIds) {
            for (const gId of gIds) addEdge(sId, gId);
        }
    }
    return adjacency;
}

function wfBuildUndirectedAdjacency(data) {
    const adj = new Map();
    const addEdge = (u, v) => {
        if (!adj.has(u)) adj.set(u, new Set());
        if (!adj.has(v)) adj.set(v, new Set());
        adj.get(u).add(v);
        adj.get(v).add(u);
    };
    for (const link of (data.links || [])) {
        if (Array.isArray(link) && link.length >= 4) {
            const u = Number(link[1]);
            const v = Number(link[3]);
            if (Number.isFinite(u) && Number.isFinite(v)) addEdge(u, v);
        }
    }
    const setsByKey = new Map();
    const getsByKey = new Map();
    for (const n of (data.nodes || [])) {
        const key = wfGetSetKey(n);
        if (!key) continue;
        if (n.type === "SetNode") {
            if (!setsByKey.has(key)) setsByKey.set(key, []);
            setsByKey.get(key).push(Number(n.id));
        } else if (n.type === "GetNode") {
            if (!getsByKey.has(key)) getsByKey.set(key, []);
            getsByKey.get(key).push(Number(n.id));
        }
    }
    for (const [key, sIds] of setsByKey.entries()) {
        const gIds = getsByKey.get(key) || [];
        for (const sId of sIds) {
            for (const gId of gIds) addEdge(sId, gId);
        }
    }
    return adj;
}

function wfGroupGraph(data, groups, membersByGroup, groupByNode) {
    const adjacency = wfLinkAdjacency(data);
    const downstream = new Map();
    const upstream = new Map();
    for (const g of groups) {
        downstream.set(g, new Set());
        upstream.set(g, new Set());
    }
    for (const g of groups) {
        const seen = new Set();
        const stack = (membersByGroup.get(g) || []).map(n => Number(n.id));
        while (stack.length) {
            const cur = stack.pop();
            for (const nb of (adjacency.get(cur) || [])) {
                if (seen.has(nb)) continue;
                seen.add(nb);
                const owner = groupByNode.get(nb);
                if (owner && owner !== g) {
                    downstream.get(g).add(owner);
                }
                stack.push(nb);
            }
        }
    }
    for (const [g, targets] of downstream.entries()) {
        for (const t of targets) {
            if (!upstream.has(t)) upstream.set(t, new Set());
            upstream.get(t).add(g);
        }
    }
    return { downstream, upstream };
}

function wfStageMap(data, groups) {
    const list = groups || wfGetGroups(data);
    const result = new Map();
    if (!list.length) return result;

    const membersByGroup = new Map();
    const groupByNode = new Map();
    const base = new Map();
    for (const g of list) {
        const m = wfMembersOf(data, g);
        membersByGroup.set(g, m);
        for (const n of m) groupByNode.set(Number(n.id), g);
        base.set(g, wfClassifyGroup(data, g));
    }
    const { downstream, upstream } = wfGroupGraph(data, list, membersByGroup, groupByNode);
    for (const g of list) {
        const b = base.get(g);
        if (b !== WF_OTHER) {
            result.set(g, b);
            continue;
        }
        const votes = new Map();
        for (const nb of (downstream.get(g) || [])) {
            const st = base.get(nb);
            if (st && st !== WF_OTHER && st !== WF_AUX) votes.set(st, (votes.get(st) || 0) + 1);
        }
        if (!votes.size) {
            for (const nb of (upstream.get(g) || [])) {
                const st = base.get(nb);
                if (st && st !== WF_OTHER && st !== WF_AUX) votes.set(st, (votes.get(st) || 0) + 1);
            }
        }
        let best = WF_OTHER;
        let bestCnt = 0;
        for (const [st, cnt] of votes.entries()) {
            if (cnt > bestCnt) {
                bestCnt = cnt;
                best = st;
            }
        }
        result.set(g, best);
    }
    return result;
}

function wfClassifyNodesByGraph(data) {
    const nodes = data.nodes || [];
    const byId = new Map(nodes.map(n => [Number(n.id), n]));
    const adj = wfBuildUndirectedAdjacency(data);
    const dirAdj = wfLinkAdjacency(data);
    const stage = new Map();

    for (const node of nodes) {
        const nid = Number(node.id);
        const ntype = String(node.type || "");
        if (WF_HELPER_TYPES.has(ntype)) {
            stage.set(nid, WF_AUX);
            continue;
        }
        if (ntype === "CreateVideo") {
            const visited = new Set();
            const q = [...(dirAdj.get(nid) || [])];
            let feedsUpscale = false;
            while (q.length) {
                const tid = q.shift();
                if (visited.has(tid)) continue;
                visited.add(tid);
                const t = byId.get(tid);
                if (!t) continue;
                const tt = String(t.type || "");
                if (tt === "SetNode" || tt === "GetNode") {
                    q.push(...(dirAdj.get(tid) || []));
                } else if (tt === "GetVideoComponents" || wfStageFromNodeType(tt) === "UPSCALE") {
                    feedsUpscale = true;
                    break;
                }
            }
            if (feedsUpscale) {
                stage.set(nid, "SAMPLING");
                continue;
            }
        }
        const nStage = wfStageFromNode(node);
        if (nStage !== WF_OTHER && nStage !== WF_AUX) {
            stage.set(nid, nStage);
        }
    }

    const q1 = [...stage.entries()].filter(([, st]) => st !== WF_AUX).map(([nid]) => nid);
    while (q1.length) {
        const cur = q1.shift();
        for (const nb of (dirAdj.get(cur) || [])) {
            if (!stage.has(nb)) {
                stage.set(nb, stage.get(cur));
                q1.push(nb);
            }
        }
    }
    const q2 = [...stage.entries()].filter(([, st]) => st !== WF_AUX).map(([nid]) => nid);
    while (q2.length) {
        const cur = q2.shift();
        for (const nb of (adj.get(cur) || [])) {
            if (!stage.has(nb)) {
                stage.set(nb, stage.get(cur));
                q2.push(nb);
            }
        }
    }
    for (const node of nodes) {
        const nid = Number(node.id);
        if (!stage.has(nid)) stage.set(nid, wfStageFromNode(node));
    }
    return stage;
}

function wfOptionalSuffix(group) {
    return /[-–—(]\s*(opt|opcional|optional)/i.test(String(group?.title || ""));
}

function wfMarkOptional(title) {
    const t = String(title || "");
    if (/[-–—(]\s*(opt|opcional|optional)/i.test(t)) return t;
    return `${t} - OPT`;
}

function wfIsNoteNode(node) {
    return wfStageFromNodeType(node?.type) === "NOTES";
}

function wfClusterNoteColumns(nodes) {
    if (!nodes || !nodes.length) return [];
    const ordered = [...nodes].sort((a, b) =>
        (Number(a.pos?.[0]) || 0) - (Number(b.pos?.[0]) || 0) ||
        (Number(a.pos?.[1]) || 0) - (Number(b.pos?.[1]) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0)
    );
    if (ordered.length === 1) return [ordered];
    const heights = ordered.map(n => wfIsCollapsed(n) ? 0 : wfComputeMinNodeHeight(n));
    const totalSingleH = heights.reduce((acc, h) => acc + h, 0) + NODE_VGAP * (ordered.length - 1);
    if (totalSingleH <= 1400) {
        return [ordered];
    }
    const col0 = [];
    const col1 = [];
    let h0 = 0;
    let h1 = 0;
    for (let i = 0; i < ordered.length; i++) {
        const n = ordered[i];
        const nh = heights[i];
        if (h0 <= h1) {
            col0.push(n);
            h0 += nh + (col0.length > 1 ? NODE_VGAP : 0);
        } else {
            col1.push(n);
            h1 += nh + (col1.length > 1 ? NODE_VGAP : 0);
        }
    }
    return col1.length ? [col0, col1] : [col0];
}

function wfClusterColumns(nodes, split = COL_THRESHOLD) {
    if (!nodes || !nodes.length) return [];
    if (nodes.every(n => wfIsNoteNode(n))) {
        return wfClusterNoteColumns(nodes);
    }
    const ordered = [...nodes].sort((a, b) =>
        (Number(a.pos?.[0]) || 0) - (Number(b.pos?.[0]) || 0) ||
        (Number(a.pos?.[1]) || 0) - (Number(b.pos?.[1]) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0)
    );
    const cols = [];
    for (const node of ordered) {
        const nx = Number(node.pos?.[0]) || 0;
        let placed = false;
        for (const col of cols) {
            if (Math.abs(nx - (Number(col[0].pos?.[0]) || 0)) < split) {
                col.push(node);
                placed = true;
                break;
            }
        }
        if (!placed) cols.push([node]);
    }
    return cols;
}

function wfTidyGroup(data, group, origin = null, members = null) {
    const groupMembers = members || wfMembersOf(data, group);
    let [gx, gy] = wfGroupBox(group);
    if (origin) {
        gx = origin[0];
        gy = origin[1];
    }
    gx = snap(gx);
    gy = snap(gy);

    const getNodes = groupMembers.filter(n => n.type === "GetNode");
    const setNodes = groupMembers.filter(n => n.type === "SetNode");
    const centralNodes = groupMembers.filter(n => n.type !== "GetNode" && n.type !== "SetNode");
    const isNotesOnly = centralNodes.length > 0 && centralNodes.every(n => wfIsNoteNode(n));

    const sortByPos = (a, b) =>
        (Number(a.pos?.[1]) || 0) - (Number(b.pos?.[1]) || 0) ||
        (Number(a.pos?.[0]) || 0) - (Number(b.pos?.[0]) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0);

    getNodes.sort(sortByPos);
    setNodes.sort(sortByPos);

    group.getNodeIds = getNodes.map(n => n.id);
    group.setNodeIds = setNodes.map(n => n.id);

    const leftOpen = getNodes.length ? true : (isNotesOnly ? false : (group.leftRailOpen !== false));
    const rightOpen = setNodes.length ? true : (isNotesOnly ? false : (group.rightRailOpen !== false));
    group.leftRailOpen = leftOpen;
    group.rightRailOpen = rightOpen;

    for (const n of getNodes) {
        if (!n.flags || typeof n.flags !== "object") n.flags = { collapsed: true };
        else n.flags.collapsed = true;
    }
    const widestGetExp = getNodes.length
        ? Math.max(MIN_RAIL_INNER_W, ...getNodes.map(n => wfDockedNodeExpandedWidth(n)))
        : MIN_RAIL_INNER_W;
    for (const n of getNodes) n.size = [widestGetExp, 60];
    const widestGet = getNodes.length
        ? Math.max(MIN_RAIL_INNER_W, ...getNodes.map(n => wfDockedNodeWidth(n)))
        : MIN_RAIL_INNER_W;
    const leftRailWidth = snapUp(widestGet + 2 * PAD);
    group.leftRailW = leftRailWidth;
    const lOpenW = leftOpen ? leftRailWidth : 0;

    const railStartY = gy + 120; // PAD_TOP_RAIL
    const leftNodeX = gx + PAD;
    let curGetY = railStartY;
    for (const n of getNodes) {
        const nh = 60;
        const bodyH = wfIsCollapsed(n) ? 0 : nh;
        n.pos = [snap(leftNodeX), snap(curGetY)];
        n.size = [widestGetExp, nh];
        curGetY += bodyH + NODE_VGAP;
    }
    const getBottom = (getNodes.length && leftOpen) ? (curGetY - NODE_VGAP) : (gy + MIN_GROUP_H - PAD);

    const centerX0 = gx + lOpenW;
    let centerW = MIN_CENTER_W;
    let centralBottom = gy + MIN_GROUP_H - PAD;
    if (centralNodes.length) {
        const columns = wfClusterColumns(centralNodes);
        let cursorX = centerX0 + PAD;
        centralBottom = gy + 90; // PAD_TOP
        for (const column of columns) {
            column.sort((a, b) => (Number(a.pos?.[1]) || 0) - (Number(b.pos?.[1]) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0));
            let cursorY = gy + 90;
            const widest = Math.max(MIN_CENTER_W, ...column.map(n => snapUp(wfNodeSize(n)[0])));
            for (const node of column) {
                const nh = wfComputeMinNodeHeight(node);
                const bodyH = wfIsCollapsed(node) ? 0 : nh;
                node.pos = [snap(cursorX), snap(cursorY)];
                node.size = [widest, nh];
                cursorY += bodyH + NODE_VGAP;
            }
            centralBottom = Math.max(centralBottom, cursorY - NODE_VGAP);
            cursorX += widest + NODE_HGAP;
        }
        centerW = Math.max(MIN_CENTER_W, snapUp((cursorX - NODE_HGAP + PAD) - centerX0));
    }

    for (const n of setNodes) {
        if (!n.flags || typeof n.flags !== "object") n.flags = { collapsed: true };
        else n.flags.collapsed = true;
    }
    const widestSetExp = setNodes.length
        ? Math.max(MIN_RAIL_INNER_W, ...setNodes.map(n => wfDockedNodeExpandedWidth(n)))
        : MIN_RAIL_INNER_W;
    for (const n of setNodes) n.size = [widestSetExp, 60];
    const widestSet = setNodes.length
        ? Math.max(MIN_RAIL_INNER_W, ...setNodes.map(n => wfDockedNodeWidth(n)))
        : MIN_RAIL_INNER_W;
    const rightRailWidth = snapUp(widestSet + 2 * PAD);
    group.rightRailW = rightRailWidth;
    const rOpenW = rightOpen ? rightRailWidth : 0;

    const rightRailX0 = centerX0 + centerW;
    const rightNodeX = rightRailX0 + PAD;
    let curSetY = railStartY;
    for (const n of setNodes) {
        const nh = 60;
        const bodyH = wfIsCollapsed(n) ? 0 : nh;
        n.pos = [snap(rightNodeX), snap(curSetY)];
        n.size = [widestSetExp, nh];
        curSetY += bodyH + NODE_VGAP;
    }
    const setBottom = (setNodes.length && rightOpen) ? (curSetY - NODE_VGAP) : (gy + MIN_GROUP_H - PAD);

    const width = snapUp(lOpenW + centerW + rOpenW);
    const maxBottomY = Math.max(gy + MIN_GROUP_H - PAD, getBottom, setBottom, centralBottom);
    const height = Math.max(MIN_GROUP_H, snapUp((maxBottomY + PAD) - gy));

    group.x = snap(gx);
    group.y = snap(gy);
    group.w = width;
    group.h = height;
    delete group.bounding;
    return [group.x, group.y, width, height];
}

function wfAdoptLooseNodes(data) {
    const groups = wfGetGroups(data);
    const membersByGroup = new Map(groups.map(g => [g, wfMembersOf(data, g)]));
    const grouped = new Set();
    const groupByNode = new Map();
    for (const [g, list] of membersByGroup.entries()) {
        for (const n of list) {
            grouped.add(Number(n.id));
            groupByNode.set(Number(n.id), g);
        }
    }
    const stageOfGroup = wfStageMap(data, groups);
    const stageOfNode = wfClassifyNodesByGraph(data);
    const byId = new Map((data.nodes || []).map(n => [Number(n.id), n]));
    const dirAdj = wfLinkAdjacency(data);
    const revAdj = new Map();
    for (const [src, dsts] of dirAdj.entries()) {
        for (const dst of dsts) {
            if (!revAdj.has(dst)) revAdj.set(dst, []);
            revAdj.get(dst).push(src);
        }
    }

    const buckets = new Map();
    const absorbed = new Map();

    const unassigned = (data.nodes || []).filter(n => {
        const nid = Number(n.id);
        const st = stageOfNode.get(nid) || WF_OTHER;
        return !grouped.has(nid) && st !== WF_OTHER && st !== WF_AUX;
    });

    const absorbInto = (node, targetGroup) => {
        const nid = Number(node.id);
        const st = stageOfNode.get(nid) || WF_OTHER;
        const gMembers = membersByGroup.get(targetGroup);
        const upInGroup = (revAdj.get(nid) || []).filter(u => groupByNode.get(u) === targetGroup).map(u => byId.get(u)).filter(Boolean);
        const downInGroup = (dirAdj.get(nid) || []).filter(d => groupByNode.get(d) === targetGroup).map(d => byId.get(d)).filter(Boolean);
        const sameType = gMembers.filter(m => m.type === node.type);

        if (upInGroup.length) {
            const ref = upInGroup[0];
            node.pos = [snap(ref.pos[0]), snap(ref.pos[1] + wfNodeSize(ref)[1] + 10)];
        } else if (downInGroup.length) {
            const ref = downInGroup[0];
            node.pos = [snap(ref.pos[0]), snap(ref.pos[1] - wfNodeSize(node)[1] - 10)];
        } else if (sameType.length) {
            const ref = sameType.reduce((a, b) => (Number(a.pos[1]) > Number(b.pos[1]) ? a : b));
            node.pos = [snap(ref.pos[0]), snap(ref.pos[1] + wfNodeSize(ref)[1] + 10)];
        } else if (gMembers.length) {
            const ref = gMembers.reduce((a, b) => (Number(a.pos[1]) > Number(b.pos[1]) ? a : b));
            node.pos = [snap(ref.pos[0]), snap(ref.pos[1] + wfNodeSize(ref)[1] + 10)];
        }

        gMembers.push(node);
        groupByNode.set(nid, targetGroup);
        grouped.add(nid);
        const label = targetGroup.title || st;
        if (!absorbed.has(label)) absorbed.set(label, []);
        absorbed.get(label).push(node);

        const [gx, gy, gw, gh] = wfGroupBox(targetGroup);
        const [nx, ny, nw, nh] = wfNodeBox(node);
        const newX = Math.min(gx, nx - PAD);
        const newY = Math.min(gy, ny - 90);
        const newW = Math.max(gx + gw, nx + nw + PAD) - newX;
        const newH = Math.max(gy + gh, ny + nh + PAD) - newY;
        targetGroup.x = snap(newX);
        targetGroup.y = snap(newY);
        targetGroup.w = snapUp(newW);
        targetGroup.h = snapUp(newH);
        delete targetGroup.bounding;
    };

    const remaining = [];
    for (const node of unassigned) {
        const nid = Number(node.id);
        const st = stageOfNode.get(nid) || WF_OTHER;
        const sameStageGroups = groups.filter(g => stageOfGroup.get(g) === st);
        if (!sameStageGroups.length) {
            if (!buckets.has(st)) buckets.set(st, []);
            buckets.get(st).push(node);
            grouped.add(nid);
        } else {
            remaining.push(node);
        }
    }

    const bucketOfNode = new Map();
    for (const [st, nlist] of buckets.entries()) {
        for (const n of nlist) bucketOfNode.set(Number(n.id), st);
    }

    const stillRemaining = [];
    for (const node of remaining) {
        const nid = Number(node.id);
        const neighborIds = [...(revAdj.get(nid) || []), ...(dirAdj.get(nid) || [])];
        const nbBuckets = new Set(neighborIds.filter(nb => bucketOfNode.has(nb)).map(nb => bucketOfNode.get(nb)));
        const nbExisting = new Set(neighborIds.filter(nb => groupByNode.has(nb)).map(nb => groupByNode.get(nb)));
        if (nbBuckets.size && !nbExisting.size) {
            const targetSt = [...nbBuckets][0];
            if (!buckets.has(targetSt)) buckets.set(targetSt, []);
            buckets.get(targetSt).push(node);
            bucketOfNode.set(nid, targetSt);
            grouped.add(nid);
            continue;
        }
        stillRemaining.push(node);
    }

    for (const node of stillRemaining) {
        const nid = Number(node.id);
        const st = stageOfNode.get(nid) || WF_OTHER;
        let targetGroup = null;
        const sameStageGroups = groups.filter(g => stageOfGroup.get(g) === st);
        if (sameStageGroups.length) {
            const neighborIds = [...(revAdj.get(nid) || []), ...(dirAdj.get(nid) || [])];
            for (const nbId of neighborIds) {
                const gCand = groupByNode.get(nbId);
                if (gCand && stageOfGroup.get(gCand) === st) {
                    targetGroup = gCand;
                    break;
                }
            }
            if (!targetGroup) {
                for (const gCand of sameStageGroups) {
                    if ((membersByGroup.get(gCand) || []).some(m => m.type === node.type)) {
                        targetGroup = gCand;
                        break;
                    }
                }
            }
        }
        if (targetGroup) {
            absorbInto(node, targetGroup);
        } else {
            if (!buckets.has(st)) buckets.set(st, []);
            buckets.get(st).push(node);
        }
    }

    const existingBoxes = groups.map(g => wfGroupBox(g));
    let farX = 0;
    let originY = 0;
    if (existingBoxes.length) {
        farX = Math.max(...existingBoxes.map(b => b[0] + b[2])) + PAD;
        originY = Math.min(...existingBoxes.map(b => b[1]));
    } else if ((data.nodes || []).length) {
        farX = Math.min(...data.nodes.map(n => Number(n.pos?.[0]) || 0));
        originY = Math.min(...data.nodes.map(n => Number(n.pos?.[1]) || 0));
    }

    let cursorY = originY;
    const created = [...absorbed.entries()].map(([title, list]) => ({ title, count: list.length }));
    let nextId = groups.length + 1;
    for (const stage of WF_STAGES) {
        const groupNodes = buckets.get(stage);
        if (!groupNodes || !groupNodes.length) continue;
        let title = WF_ADOPT_TITLES[stage] || stage;
        const bypassed = groupNodes.filter(n => n.mode === 4).length;
        if (bypassed / groupNodes.length >= 0.6) title = wfMarkOptional(title);
        const color = wfGroupColorFor(stage, { title }, groupNodes);
        const group = {
            id: `evmg_adopt_${stage.toLowerCase()}_${nextId}`,
            title,
            x: snap(farX),
            y: snap(cursorY),
            w: DEFAULT_RAIL_W * 2 + MIN_CENTER_W,
            h: MIN_GROUP_H,
            leftRailOpen: true,
            rightRailOpen: true,
            leftRailW: DEFAULT_RAIL_W,
            rightRailW: DEFAULT_RAIL_W,
            color,
            titleColor: color,
            bodyColor: color,
            fontSize: DEF_FONT_SIZE,
            getNodeIds: [],
            setNodeIds: [],
            _colorMigratedV2: true,
        };
        groups.push(group);
        const bounding = wfTidyGroup(data, group, [farX, cursorY], groupNodes);
        cursorY = bounding[1] + bounding[3] + PAD;
        created.push({ title, count: groupNodes.length });
        nextId += 1;
    }
    wfSetGroups(data, groups);
    return created;
}

function wfBuildGroups(data) {
    const nodes = (data.nodes || []).filter(n => !WF_HELPER_TYPES.has(String(n.type)));
    const stageOf = wfClassifyNodesByGraph(data);
    const buckets = new Map();
    for (const node of nodes) {
        const st = stageOf.get(Number(node.id)) || WF_OTHER;
        if (st === WF_AUX) continue;
        if (!buckets.has(st)) buckets.set(st, []);
        buckets.get(st).push(node);
    }

    const originX = nodes.length ? (Math.min(...nodes.map(n => Number(n.pos?.[0]) || 0)) - DEFAULT_RAIL_W - PAD) : 0;
    const originY = nodes.length ? (Math.min(...nodes.map(n => Number(n.pos?.[1]) || 0)) - 90) : 0;
    const groups = [];
    let nextId = 1;
    let cursorX = originX;

    for (const stage of [...WF_STAGES, WF_OTHER]) {
        const groupNodes = buckets.get(stage);
        if (!groupNodes || !groupNodes.length) continue;
        const title = WF_ADOPT_TITLES[stage] || stage;
        const color = wfGroupColorFor(stage, { title }, groupNodes);
        const group = {
            id: `evmg_${stage.toLowerCase()}_${nextId}`,
            title,
            x: snap(cursorX),
            y: snap(originY),
            w: DEFAULT_RAIL_W * 2 + MIN_CENTER_W,
            h: MIN_GROUP_H,
            leftRailOpen: true,
            rightRailOpen: true,
            leftRailW: DEFAULT_RAIL_W,
            rightRailW: DEFAULT_RAIL_W,
            color,
            titleColor: color,
            bodyColor: color,
            fontSize: DEF_FONT_SIZE,
            getNodeIds: [],
            setNodeIds: [],
            _colorMigratedV2: true,
        };
        groups.push(group);
        const bounding = wfTidyGroup(data, group, [cursorX, originY], groupNodes);
        cursorX = bounding[0] + bounding[2] + PAD;
        nextId += 1;
    }
    wfSetGroups(data, groups);
    return groups;
}

function wfAssignMembers(data, groups) {
    const assignment = new Map(groups.map(g => [g, []]));
    const byId = new Map((data.nodes || []).map(n => [Number(n.id), n]));
    const candidates = new Map();

    for (const g of groups) {
        for (const node of wfMembersOf(data, g)) {
            if (WF_HELPER_TYPES.has(String(node.type))) continue;
            const nid = Number(node.id);
            if (!candidates.has(nid)) candidates.set(nid, []);
            candidates.get(nid).push(g);
        }
    }

    for (const [nodeId, owners] of candidates.entries()) {
        const node = byId.get(nodeId);
        if (!node) continue;
        const best = owners.reduce((a, b) => {
            const ba = wfGroupBox(a);
            const bb = wfGroupBox(b);
            return (ba[2] * ba[3] <= bb[2] * bb[3]) ? a : b;
        });
        assignment.get(best).push(node);
    }
    return assignment;
}

function wfSanitizeGroupPrefix(title) {
    let raw = String(title || "").trim();
    raw = raw.replace(/\s*[-–—(]\s*(opt|opcional|optional)\)?\s*$/i, "").trim();
    if (!raw) return "Group";
    let s = raw.replace(/\s+/g, "_");
    s = s.replace(/[^a-zA-Z0-9_\-\u00C0-\u017F]/g, "");
    s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return s || "Group";
}

function wfSplitMixedInputOutputGroups(data, groups, assignment) {
    const links = data.links || [];
    const linkById = new Map();
    for (const lk of links) {
        if (Array.isArray(lk) && lk.length >= 5) linkById.set(Number(lk[0]), lk);
    }

    const isPurePreviewType = (ntype) =>
        /^(PreviewImage|PreviewAudio|MaskPreview|ShowText|PreviewAny|TextPreview)/i.test(String(ntype || ""));

    const deriveSplitTitles = (origTitle, inputNodes, outputNodes) => {
        const raw = String(origTitle || "").trim();
        const hasAudioIn = inputNodes.some(n => /Audio|Voice|Voz|TTS|Music/i.test(String(n.type || "")));
        const hasVideoIn = inputNodes.some(n => /Video/i.test(String(n.type || "")));
        const hasVideoOut = outputNodes.some(n => /Video/i.test(String(n.type || "")));

        let inTitle = hasAudioIn ? "Load Audio" : (hasVideoIn ? "Load Video" : "Load Image");
        let outTitle = hasVideoOut ? "Save Video" : "Save Image";

        // Se o título original tinha separador explícito ("Load + Save Image", "Input / Output", etc.)
        const parts = raw.split(/\s*(?:\+|&|\/|\be\b|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
            const [p1, p2] = parts;
            if (/load|input|ref|image|audio|video/i.test(p1) && /save|output|export|preview/i.test(p2)) {
                inTitle = /image|audio|video|input/i.test(p1) ? p1 : `${p1} ${p2.replace(/^.*?(image|audio|video)/i, "$1")}`.trim();
                outTitle = p2;
            }
        }
        return [inTitle, outTitle];
    };

    const newGroups = [];
    let nextSplitIdx = groups.length + 1;

    for (const g of groups) {
        const members = assignment.get(g) || [];
        const central = members.filter(n => n.type !== "GetNode" && n.type !== "SetNode");
        if (central.length < 2) {
            newGroups.push(g);
            continue;
        }

        const centralIds = new Set(central.map(n => Number(n.id)));
        const inputSeeds = central.filter(n => wfStageFromNode(n) === "INPUT");
        if (!inputSeeds.length) {
            newGroups.push(g);
            continue;
        }

        // Expande o conjunto de INPUT para nós auxiliares/escala ligados diretamente aos inputs (e Previews exclusivos do input)
        const inputSet = new Set(inputSeeds.map(n => Number(n.id)));
        let changed = true;
        while (changed) {
            changed = false;
            for (const n of central) {
                const nid = Number(n.id);
                if (inputSet.has(nid)) continue;
                const st = wfStageFromNode(n);
                if (st === "OUTPUT") {
                    // Só absorve no inputSet se for um nó de Preview alimentado exclusivamente pelo inputSet
                    if (isPurePreviewType(n.type)) {
                        const inLinks = (n.inputs || []).map(inp => inp?.link).filter(lid => lid != null && linkById.has(Number(lid)));
                        if (inLinks.length > 0 && inLinks.every(lid => inputSet.has(Number(linkById.get(Number(lid))[1])))) {
                            inputSet.add(nid);
                            changed = true;
                        }
                    }
                    continue;
                }
                // Se for outro nó de INPUT ou transformação alimentada pelo inputSet
                const fedByInput = (n.inputs || []).some(inp => {
                    const lid = inp?.link;
                    return lid != null && linkById.has(Number(lid)) && inputSet.has(Number(linkById.get(Number(lid))[1]));
                });
                if (fedByInput && (st === "INPUT" || st === "SETTINGS" || st === WF_OTHER)) {
                    inputSet.add(nid);
                    changed = true;
                }
            }
        }

        // Verifica se sobrou pelo menos um nó de OUTPUT legítimo fora do inputSet
        const remainingCentral = central.filter(n => !inputSet.has(Number(n.id)));
        const hasTrueOutput = remainingCentral.some(n => wfStageFromNode(n) === "OUTPUT");
        if (!hasTrueOutput || !remainingCentral.length) {
            newGroups.push(g);
            continue;
        }

        // Só separa se todos os nós restantes pertencerem ao fluxo de saída (OUTPUT)
        const nonOutputRemaining = remainingCentral.filter(n => wfStageFromNode(n) !== "OUTPUT");
        if (nonOutputRemaining.length > 0) {
            newGroups.push(g);
            continue;
        }

        const inputNodes = central.filter(n => inputSet.has(Number(n.id)));
        const outputNodes = remainingCentral;

        // Separa também os GetNodes e SetNodes ancorados no grupo conforme a qual subconjunto estão ligados
        const getNodes = members.filter(n => n.type === "GetNode");
        const setNodes = members.filter(n => n.type === "SetNode");

        const inputGets = [];
        const outputGets = [];
        for (const gn of getNodes) {
            const feedsInput = (gn.outputs || []).some(out =>
                (out?.links || []).some(lid => linkById.has(Number(lid)) && inputSet.has(Number(linkById.get(Number(lid))[3])))
            );
            if (feedsInput) inputGets.push(gn);
            else outputGets.push(gn);
        }

        const inputSets = [];
        const outputSets = [];
        for (const sn of setNodes) {
            const fedByInput = (sn.inputs || []).some(inp => {
                const lid = inp?.link;
                return lid != null && linkById.has(Number(lid)) && inputSet.has(Number(linkById.get(Number(lid))[1]));
            });
            if (fedByInput) inputSets.push(sn);
            else outputSets.push(sn);
        }

        const [inTitle, outTitle] = deriveSplitTitles(g.title, inputNodes, outputNodes);
        const inColor = wfGroupColorFor("INPUT", { title: inTitle }, inputNodes);
        const outColor = wfGroupColorFor("OUTPUT", { title: outTitle }, outputNodes);

        const inGroup = {
            ...JSON.parse(JSON.stringify(g)),
            id: `evmg_input_${nextSplitIdx++}`,
            title: inTitle,
            color: inColor,
            titleColor: inColor,
            bodyColor: inColor,
            getNodeIds: inputGets.map(n => n.id),
            setNodeIds: inputSets.map(n => n.id),
            leftRailOpen: inputGets.length > 0,
            rightRailOpen: inputSets.length > 0,
            _stage: "INPUT",
        };

        g.title = outTitle;
        g.color = outColor;
        g.titleColor = outColor;
        g.bodyColor = outColor;
        g.getNodeIds = outputGets.map(n => n.id);
        g.setNodeIds = outputSets.map(n => n.id);
        g.leftRailOpen = outputGets.length > 0;
        g.rightRailOpen = outputSets.length > 0;
        g._stage = "OUTPUT";

        assignment.set(inGroup, [...inputNodes, ...inputGets, ...inputSets]);
        assignment.set(g, [...outputNodes, ...outputGets, ...outputSets]);

        newGroups.push(inGroup, g);
    }

    if (newGroups.length !== groups.length) {
        groups.splice(0, groups.length, ...newGroups);
        wfSetGroups(data, groups);
    }
}

function wfEnsureNotesGrouped(data, groups, assignment) {
    const allNodes = data.nodes || [];
    const allNoteNodes = allNodes.filter(n => wfIsNoteNode(n));
    if (!allNoteNodes.length) {
        // Mesmo sem nós de nota, se houver grupo com título de nota, força estágio NOTES e cor preta
        for (const g of groups) {
            if (wfStageFromText(g.title) === "NOTES") {
                const c = WF_PALETTE.NOTES.group;
                g._stage = "NOTES";
                g.color = c;
                g.titleColor = c;
                g.bodyColor = c;
            }
        }
        return;
    }

    const noteGroups = [];
    const noteAssignedIds = new Set();

    // 1. Identifica grupos puramente de notas e extrai notas misturadas em grupos de outras etapas
    for (const g of groups) {
        const members = assignment.get(g) || [];
        const central = members.filter(n => n.type !== "GetNode" && n.type !== "SetNode");
        const notesInG = central.filter(n => wfIsNoteNode(n));
        const nonNotesInG = central.filter(n => !wfIsNoteNode(n));
        const isNoteTitle = wfStageFromText(g.title) === "NOTES";

        if (isNoteTitle && nonNotesInG.length === 0) {
            noteGroups.push(g);
            g._stage = "NOTES";
            for (const n of notesInG) noteAssignedIds.add(Number(n.id));
        } else if (notesInG.length > 0 && nonNotesInG.length === 0) {
            noteGroups.push(g);
            g._stage = "NOTES";
            if (!g.title || /^(group|grupo|nodes?\s*\d*|\d+)$/i.test(String(g.title).trim())) {
                g.title = notesInG.every(n => n.type === "MarkdownNote") ? "Markdown Notes" : "Notes";
            }
            for (const n of notesInG) noteAssignedIds.add(Number(n.id));
        } else if (notesInG.length > 0 && nonNotesInG.length > 0) {
            // Retira as notas que estavam misturadas com nós de outra etapa
            assignment.set(g, members.filter(n => !wfIsNoteNode(n)));
        }
    }

    // 2. Coleta todas as notas ainda sem grupo de notas (soltas ou extraídas de grupos mistos)
    const looseNotes = allNoteNodes.filter(n => !noteAssignedIds.has(Number(n.id)));
    if (looseNotes.length > 0) {
        if (noteGroups.length > 0) {
            const targetG = noteGroups[0];
            const curList = assignment.get(targetG) || [];
            for (const n of looseNotes) {
                if (!curList.some(x => Number(x.id) === Number(n.id))) {
                    curList.push(n);
                }
            }
            assignment.set(targetG, curList);
        } else {
            const nonNoteBoxes = groups.map(g => wfGroupBox(g));
            const baseX = nonNoteBoxes.length
                ? Math.min(...nonNoteBoxes.map(b => b[0]))
                : Math.min(...looseNotes.map(n => Number(n.pos?.[0]) || 0));
            const baseY = nonNoteBoxes.length
                ? Math.min(...nonNoteBoxes.map(b => b[1]))
                : Math.min(...looseNotes.map(n => Number(n.pos?.[1]) || 0));
            const allMarkdown = looseNotes.every(n => n.type === "MarkdownNote");
            const title = allMarkdown ? "Markdown Notes" : "Notes";
            const color = WF_PALETTE.NOTES.group;
            const noteGroup = {
                id: `evmg_notes_${groups.length + 1}`,
                title,
                x: snap(baseX),
                y: snap(baseY),
                w: MIN_CENTER_W + 2 * PAD,
                h: MIN_GROUP_H,
                leftRailOpen: false,
                rightRailOpen: false,
                leftRailW: DEFAULT_RAIL_W,
                rightRailW: DEFAULT_RAIL_W,
                color,
                titleColor: color,
                bodyColor: color,
                fontSize: DEF_FONT_SIZE,
                getNodeIds: [],
                setNodeIds: [],
                _colorMigratedV2: true,
                _stage: "NOTES",
            };
            groups.unshift(noteGroup);
            assignment.set(noteGroup, [...looseNotes]);
            noteGroups.push(noteGroup);
            wfSetGroups(data, groups);
        }
    }

    // 3. Garante cor preta e trilhos fechados em todos os grupos de notas
    for (const ng of noteGroups) {
        const c = WF_PALETTE.NOTES.group;
        ng._stage = "NOTES";
        ng.color = c;
        ng.titleColor = c;
        ng.bodyColor = c;
        const m = assignment.get(ng) || [];
        ng.leftRailOpen = m.some(n => n.type === "GetNode");
        ng.rightRailOpen = m.some(n => n.type === "SetNode");
    }
}

function wfWireSetGetBetweenGroups(data, groups, assignment) {
    const nodes = data.nodes || [];
    const links = data.links || [];
    if (!nodes.length || !links.length || !groups.length) return [0, 0];

    const byId = new Map(nodes.map(n => [Number(n.id), n]));
    const groupOfNode = new Map();
    for (const g of groups) {
        for (const n of (assignment.get(g) || [])) {
            groupOfNode.set(Number(n.id), g);
        }
    }

    const linkById = new Map();
    for (const lk of links) {
        if (Array.isArray(lk) && lk.length >= 5) {
            linkById.set(Number(lk[0]), lk);
        }
    }

    const usedKeys = new Set();
    const existingSetForOutput = new Map(); // `${srcId}:${srcSlot}` -> { setNode, key }
    const existingGetInGroup = new Map();   // g -> Map(key -> getNode)
    const producerByKey = new Map();        // key -> [srcId, srcSlot]

    const reassignDockedNode = (node, targetGroup) => {
        const nid = Number(node.id);
        const oldGroup = groupOfNode.get(nid);
        if (oldGroup === targetGroup) return;
        if (oldGroup && assignment.has(oldGroup)) {
            assignment.set(oldGroup, assignment.get(oldGroup).filter(x => Number(x.id) !== nid));
            for (const keyList of ["getNodeIds", "setNodeIds"]) {
                if (Array.isArray(oldGroup[keyList])) {
                    oldGroup[keyList] = oldGroup[keyList].filter(x => String(x) !== String(nid));
                }
            }
        }
        if (targetGroup && assignment.has(targetGroup)) {
            const arr = assignment.get(targetGroup);
            if (!arr.some(x => Number(x.id) === nid)) arr.push(node);
            groupOfNode.set(nid, targetGroup);
            const keyList = node.type === "SetNode" ? "setNodeIds" : "getNodeIds";
            if (!Array.isArray(targetGroup[keyList])) targetGroup[keyList] = [];
            if (!targetGroup[keyList].some(x => String(x) === String(nid))) {
                targetGroup[keyList].push(nid);
            }
            if (!node.flags || typeof node.flags !== "object") node.flags = { collapsed: true };
            else if (!("collapsed" in node.flags)) node.flags.collapsed = true;
        }
    };

    for (const n of nodes) {
        if (n.type === "SetNode") {
            let k = wfGetSetKey(n);
            for (const inp of (n.inputs || [])) {
                const lid = inp?.link;
                if (lid != null && linkById.has(Number(lid))) {
                    const lk = linkById.get(Number(lid));
                    const originId = Number(lk[1]);
                    const originSlot = Number(lk[2]);
                    const prodGroup = groupOfNode.get(originId);
                    if (prodGroup) {
                        reassignDockedNode(n, prodGroup);
                        const prefix = wfSanitizeGroupPrefix(prodGroup.title);
                        const inType = String(inp.type || lk[5] || "*").split(",")[0].trim().toUpperCase();
                        const rawType = inType.replace(/[^a-zA-Z0-9_]/g, "") || "OUT";
                        const expectedBase = `${prefix}_${rawType}`;
                        const reBase = new RegExp(`^${expectedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d+)?$`);
                        if (!k || !reBase.test(k)) {
                            let newK = expectedBase;
                            let cnt = 2;
                            while (usedKeys.has(newK)) {
                                newK = `${expectedBase}_${cnt}`;
                                cnt += 1;
                            }
                            const oldK = k;
                            k = newK;
                            n.title = `Set_${k}`;
                            n.widgets_values = [k];
                            n.widgets_values_named = { Constant: k };
                            if (!n.properties || typeof n.properties !== "object") n.properties = {};
                            n.properties.previousName = k;
                            n.properties.evmGroupPrefix = prefix;
                            n.properties.evmAutoNamed = true;
                            if (oldK) {
                                for (const gn of nodes) {
                                    if (gn.type === "GetNode" && wfGetSetKey(gn) === oldK) {
                                        gn.title = `Get_${k}`;
                                        gn.widgets_values = [k];
                                        gn.widgets_values_named = { Constant: k };
                                    }
                                }
                            }
                        }
                    }
                    existingSetForOutput.set(`${originId}:${originSlot}`, { setNode: n, key: k });
                    if (k) producerByKey.set(k, [originId, originSlot]);
                }
            }
            if (k) {
                usedKeys.add(k);
                n.widgets_values = [k];
                n.widgets_values_named = { Constant: k };
            }
        } else if (n.type === "GetNode") {
            const k = wfGetSetKey(n);
            if (k) {
                n.widgets_values = [k];
                n.widgets_values_named = { Constant: k };
            }
            let g = groupOfNode.get(Number(n.id));
            const consumerGroups = [];
            for (const out of (n.outputs || [])) {
                for (const lid of (out?.links || [])) {
                    if (lid != null && linkById.has(Number(lid))) {
                        const lk = linkById.get(Number(lid));
                        const cg = groupOfNode.get(Number(lk[3]));
                        if (cg && !consumerGroups.includes(cg)) consumerGroups.push(cg);
                    }
                }
            }
            if (consumerGroups.length && (!g || !consumerGroups.includes(g))) {
                g = consumerGroups[0];
                reassignDockedNode(n, g);
            }
            if (k && g) {
                if (!existingGetInGroup.has(g)) existingGetInGroup.set(g, new Map());
                existingGetInGroup.get(g).set(k, n);
            }
        }
    }

    // Identifica links cruzando grupos diferentes
    // Map: producerKey (`${srcId}:${srcSlot}`) -> { srcGroup, srcId, srcSlot, consumers: Map(dstGroup -> [lk]) }
    const crossLinks = new Map();
    const addCrossLink = (srcGroup, srcId, srcSlot, dstGroup, lk) => {
        const pKey = `${srcId}:${srcSlot}`;
        if (!crossLinks.has(pKey)) {
            crossLinks.set(pKey, { srcGroup, srcId, srcSlot, consumers: new Map() });
        }
        const entry = crossLinks.get(pKey);
        if (!entry.consumers.has(dstGroup)) entry.consumers.set(dstGroup, []);
        entry.consumers.get(dstGroup).push(lk);
    };

    for (const lk of links) {
        if (!Array.isArray(lk) || lk.length < 5) continue;
        const srcId = Number(lk[1]);
        const srcSlot = Number(lk[2]);
        const dstId = Number(lk[3]);
        const srcNode = byId.get(srcId);
        const dstNode = byId.get(dstId);
        if (!srcNode || !dstNode) continue;
        if (dstNode.type === "SetNode" || dstNode.type === "GetNode" || srcNode.type === "SetNode") continue;
        if (WF_HELPER_TYPES.has(String(srcNode.type)) || WF_HELPER_TYPES.has(String(dstNode.type))) continue;

        const srcGroup = groupOfNode.get(srcId);
        const dstGroup = groupOfNode.get(dstId);
        if (!srcGroup || !dstGroup || srcGroup === dstGroup) continue;

        if (srcNode.type === "GetNode") {
            const k = wfGetSetKey(srcNode);
            if (producerByKey.has(k)) {
                const [realSrcId, realSrcSlot] = producerByKey.get(k);
                const realSrcGroup = groupOfNode.get(realSrcId);
                if (realSrcGroup && realSrcGroup !== dstGroup) {
                    addCrossLink(realSrcGroup, realSrcId, realSrcSlot, dstGroup, lk);
                }
            }
            continue;
        }
        addCrossLink(srcGroup, srcId, srcSlot, dstGroup, lk);
    }

    if (!crossLinks.size) {
        for (const g of groups) {
            const gMembers = assignment.get(g) || [];
            g.leftRailOpen = gMembers.some(n => n.type === "GetNode");
            g.rightRailOpen = gMembers.some(n => n.type === "SetNode");
        }
        return [0, 0];
    }

    let maxNodeId = Math.max(Number(data.last_node_id) || 0, ...nodes.map(n => Number(n.id) || 0));
    let maxLinkId = Math.max(Number(data.last_link_id) || 0, ...links.map(lk => (Array.isArray(lk) ? Number(lk[0]) || 0 : 0)));
    let maxOrder = Math.max(0, ...nodes.map(n => Number(n.order) || 0));

    let setCreated = 0;
    let getCreated = 0;

    const sortedProducers = [...crossLinks.values()].sort((a, b) => {
        const na = byId.get(a.srcId);
        const nb = byId.get(b.srcId);
        return (
            (Number(na?.pos?.[1]) || 0) - (Number(nb?.pos?.[1]) || 0) ||
            (Number(na?.pos?.[0]) || 0) - (Number(nb?.pos?.[0]) || 0) ||
            a.srcId - b.srcId ||
            a.srcSlot - b.srcSlot
        );
    });

    for (const item of sortedProducers) {
        const { srcGroup, srcId, srcSlot, consumers } = item;
        const srcNode = byId.get(srcId);
        let dataType = "*";
        const srcOutputs = srcNode?.outputs || [];
        if (srcSlot >= 0 && srcSlot < srcOutputs.length && srcOutputs[srcSlot]?.type) {
            dataType = String(srcOutputs[srcSlot].type);
        }
        if (dataType === "*") {
            const firstLkList = [...consumers.values()][0];
            if (firstLkList?.[0]?.[5]) dataType = String(firstLkList[0][5]);
        }

        const outKey = `${srcId}:${srcSlot}`;
        let finalKey = "";
        if (existingSetForOutput.has(outKey)) {
            finalKey = existingSetForOutput.get(outKey).key;
        } else {
            const prefix = wfSanitizeGroupPrefix(srcGroup.title);
            const rawType = dataType.replace(/[^a-zA-Z0-9_]/g, "") || "DATA";
            const baseKey = `${prefix}_${rawType}`;
            finalKey = baseKey;
            let counter = 2;
            while (usedKeys.has(finalKey)) {
                finalKey = `${baseKey}_${counter}`;
                counter += 1;
            }
            usedKeys.add(finalKey);

            maxNodeId += 1;
            maxLinkId += 1;
            maxOrder += 1;
            const setNodeId = maxNodeId;
            const setLinkId = maxLinkId;

            const srcStage = srcGroup._stage || wfClassifyGroup(data, srcGroup);
            const style = WF_PALETTE[srcStage] || WF_PALETTE.OTHER;
            const nodeColor = style.node || "#1b4669";
            const nodeBg = style.bg || "#29699c";

            const newSetLink = [setLinkId, srcId, srcSlot, setNodeId, 0, dataType];
            links.push(newSetLink);
            linkById.set(setLinkId, newSetLink);

            if (srcSlot >= 0 && srcSlot < srcOutputs.length && srcOutputs[srcSlot]) {
                if (!Array.isArray(srcOutputs[srcSlot].links)) srcOutputs[srcSlot].links = [];
                srcOutputs[srcSlot].links.push(setLinkId);
            }

            const setNode = {
                id: setNodeId,
                type: "SetNode",
                title: `Set_${finalKey}`,
                pos: [
                    snap((Number(srcNode.pos?.[0]) || 0) + wfNodeSize(srcNode)[0] + PAD),
                    snap((Number(srcNode.pos?.[1]) || 0) + srcSlot * 20),
                ],
                size: [MIN_RAIL_INNER_W, 60],
                flags: { collapsed: true },
                order: maxOrder,
                mode: 0,
                inputs: [{ name: dataType, type: dataType, link: setLinkId }],
                outputs: [{ name: "*", type: "*", links: [] }],
                properties: {
                    "Node name for S&R": "SetNode",
                    aux_id: "kijai/ComfyUI-KJNodes",
                    previousName: finalKey,
                    evmGroupPrefix: prefix,
                    evmAutoNamed: true,
                },
                widgets_values: [finalKey],
                widgets_values_named: { Constant: finalKey },
                color: nodeColor,
                bgcolor: nodeBg,
            };
            setNode.size[0] = wfDockedNodeExpandedWidth(setNode);
            nodes.push(setNode);
            byId.set(setNodeId, setNode);
            assignment.get(srcGroup).push(setNode);
            groupOfNode.set(setNodeId, srcGroup);
            if (!Array.isArray(srcGroup.setNodeIds)) srcGroup.setNodeIds = [];
            if (!srcGroup.setNodeIds.includes(setNodeId)) srcGroup.setNodeIds.push(setNodeId);
            existingSetForOutput.set(outKey, { setNode, key: finalKey });
            setCreated += 1;
        }

        for (const [dstGroup, lkList] of consumers.entries()) {
            if (!existingGetInGroup.has(dstGroup)) existingGetInGroup.set(dstGroup, new Map());
            const dstMap = existingGetInGroup.get(dstGroup);
            let getNode = dstMap.get(finalKey);
            let getNodeId;

            if (getNode) {
                getNodeId = Number(getNode.id);
            } else {
                maxNodeId += 1;
                maxOrder += 1;
                getNodeId = maxNodeId;

                const dstStage = dstGroup._stage || wfClassifyGroup(data, dstGroup);
                const style = WF_PALETTE[dstStage] || WF_PALETTE.OTHER;
                const nodeColor = style.node || "#1b4669";
                const nodeBg = style.bg || "#29699c";

                const firstDstNode = byId.get(Number(lkList[0][3]));
                const firstDstSlot = Number(lkList[0][4]) || 0;
                const initY = firstDstNode
                    ? ((Number(firstDstNode.pos?.[1]) || 0) + firstDstSlot * 20)
                    : ((Number(dstGroup.y) || 0) + 120);
                const initX = (Number(dstGroup.x) || 0) + PAD;

                getNode = {
                    id: getNodeId,
                    type: "GetNode",
                    title: `Get_${finalKey}`,
                    pos: [snap(initX), snap(initY)],
                    size: [MIN_RAIL_INNER_W, 60],
                    flags: { collapsed: true },
                    order: maxOrder,
                    mode: 0,
                    inputs: [],
                    outputs: [{ name: dataType, type: dataType, links: [], slot_index: 0 }],
                    properties: {
                        "Node name for S&R": "GetNode",
                        aux_id: "kijai/ComfyUI-KJNodes",
                    },
                    widgets_values: [finalKey],
                    widgets_values_named: { Constant: finalKey },
                    color: nodeColor,
                    bgcolor: nodeBg,
                };
                getNode.size[0] = wfDockedNodeExpandedWidth(getNode);
                nodes.push(getNode);
                byId.set(getNodeId, getNode);
                assignment.get(dstGroup).push(getNode);
                groupOfNode.set(getNodeId, dstGroup);
                if (!Array.isArray(dstGroup.getNodeIds)) dstGroup.getNodeIds = [];
                if (!dstGroup.getNodeIds.includes(getNodeId)) dstGroup.getNodeIds.push(getNodeId);
                dstMap.set(finalKey, getNode);
                getCreated += 1;
            }

            if (!Array.isArray(getNode.outputs[0].links)) getNode.outputs[0].links = [];
            const getOutLinks = getNode.outputs[0].links;
            for (const lk of lkList) {
                const lid = Number(lk[0]);
                const oldSrcNode = byId.get(Number(lk[1]));
                const oldSrcSlot = Number(lk[2]);
                if (oldSrcNode?.outputs?.[oldSrcSlot]?.links) {
                    const arr = oldSrcNode.outputs[oldSrcSlot].links;
                    const idx = arr.indexOf(lid);
                    if (idx !== -1) arr.splice(idx, 1);
                }
                lk[1] = getNodeId;
                lk[2] = 0;
                if (!getOutLinks.includes(lid)) getOutLinks.push(lid);
            }
        }
    }

    data.last_node_id = maxNodeId;
    data.last_link_id = maxLinkId;

    // Remove GetNodes órfãos sem links de saída
    const orphanGetIds = new Set(
        nodes
            .filter(n => n.type === "GetNode" && !(n.outputs || []).some(o => Array.isArray(o?.links) && o.links.length > 0))
            .map(n => Number(n.id))
    );
    if (orphanGetIds.size) {
        data.nodes = nodes.filter(n => !orphanGetIds.has(Number(n.id)));
        for (const g of groups) {
            if (Array.isArray(g.getNodeIds)) {
                g.getNodeIds = g.getNodeIds.filter(nid => !orphanGetIds.has(Number(nid)));
            }
            if (assignment.has(g)) {
                assignment.set(g, assignment.get(g).filter(n => !orphanGetIds.has(Number(n.id))));
            }
        }
    }

    for (const g of groups) {
        const gMembers = assignment.get(g) || [];
        g.leftRailOpen = gMembers.some(n => n.type === "GetNode");
        g.rightRailOpen = gMembers.some(n => n.type === "SetNode");
    }
    return [setCreated, getCreated];
}

function wfDependencyLevels(data, groups, membersByGroup, groupByNode) {
    const local = new Set(groups);
    const { downstream } = wfGroupGraph(data, groups, membersByGroup, groupByNode);
    const localDown = new Map();
    const feeders = new Map();
    for (const g of local) {
        localDown.set(g, new Set([...(downstream.get(g) || [])].filter(t => local.has(t))));
        feeders.set(g, new Set());
    }
    for (const [g, targets] of localDown.entries()) {
        for (const t of targets) feeders.get(t).add(g);
    }
    const degree = new Map();
    const level = new Map();
    const queue = [];
    for (const g of local) {
        const d = feeders.get(g).size;
        degree.set(g, d);
        level.set(g, 0);
        if (d === 0) queue.push(g);
    }
    while (queue.length) {
        const g = queue.shift();
        for (const t of (localDown.get(g) || [])) {
            level.set(t, Math.max(level.get(t), level.get(g) + 1));
            degree.set(t, degree.get(t) - 1);
            if (degree.get(t) === 0) queue.push(t);
        }
    }
    return level;
}

function wfDirectFeeders(data, localGroups, groupByNode) {
    const direct = new Map();
    for (const g of localGroups) direct.set(g, new Set());
    for (const link of (data.links || [])) {
        if (!Array.isArray(link) || link.length < 4) continue;
        const src = groupByNode.get(Number(link[1]));
        const dst = groupByNode.get(Number(link[3]));
        if (src && dst && src !== dst && localGroups.has(src) && localGroups.has(dst)) {
            direct.get(dst).add(src);
        }
    }
    const setsByKey = new Map();
    const getsByKey = new Map();
    for (const n of (data.nodes || [])) {
        const key = wfGetSetKey(n);
        if (!key) continue;
        if (n.type === "SetNode") {
            if (!setsByKey.has(key)) setsByKey.set(key, []);
            setsByKey.get(key).push(Number(n.id));
        } else if (n.type === "GetNode") {
            if (!getsByKey.has(key)) getsByKey.set(key, []);
            getsByKey.get(key).push(Number(n.id));
        }
    }
    for (const [key, sIds] of setsByKey.entries()) {
        for (const sId of sIds) {
            const src = groupByNode.get(sId);
            if (!src || !localGroups.has(src)) continue;
            for (const gId of (getsByKey.get(key) || [])) {
                const dst = groupByNode.get(gId);
                if (dst && localGroups.has(dst) && dst !== src) {
                    direct.get(dst).add(src);
                }
            }
        }
    }
    return direct;
}

function wfChainColumns(data, groups, columns, groupByNode) {
    const local = new Set(groups);
    if (!local.size) return columns;

    const colOf = new Map();
    columns.forEach((col, idx) => {
        for (const g of col) colOf.set(g, idx);
    });

    const direct = wfDirectFeeders(data, local, groupByNode);
    const consumers = new Map();
    for (const [g, sources] of direct.entries()) {
        for (const src of sources) {
            if (!consumers.has(src)) consumers.set(src, new Set());
            consumers.get(src).add(g);
        }
    }

    const bridges = [];
    for (const g of local) {
        if (g._stage !== "UPSCALE") continue;
        const sources = [...(direct.get(g) || [])].filter(f => f._stage === "SAMPLING");
        if (!sources.length) continue;
        const downSampling = [...(consumers.get(g) || [])].filter(
            c => c._stage === "SAMPLING" && colOf.get(c) < colOf.get(g)
        );
        if (!downSampling.length) continue;
        const anchor = sources.reduce((a, b) => (colOf.get(a) >= colOf.get(b) ? a : b));
        if (colOf.get(anchor) + 1 < colOf.get(g)) {
            bridges.push({ anchorCol: colOf.get(anchor), gCol: colOf.get(g), g, anchor });
        }
    }

    bridges.sort((a, b) => a.anchorCol - b.anchorCol || a.gCol - b.gCol);
    for (const { g, anchor } of bridges) {
        const colIdx = columns.findIndex(c => c.includes(g));
        if (colIdx !== -1) {
            columns[colIdx] = columns[colIdx].filter(x => x !== g);
            if (!columns[colIdx].length) columns.splice(colIdx, 1);
        }
        const targetIdx = columns.findIndex(c => c.includes(anchor)) + 1;
        columns.splice(targetIdx, 0, [g]);
    }

    for (const col of columns) {
        col.sort((a, b) => {
            const ba = wfGroupBox(a);
            const bb = wfGroupBox(b);
            return ba[1] - bb[1] || ba[0] - bb[0];
        });
    }
    return columns;
}

function wfPaintNodes(data, group, stage, members) {
    const style = WF_PALETTE[stage];
    if (!style || !style.node) return 0;
    const list = members || wfMembersOf(data, group);
    let changed = 0;
    for (const node of list) {
        if (WF_HELPER_TYPES.has(String(node.type))) continue;
        if (node.color !== style.node || node.bgcolor !== style.bg) {
            node.color = style.node;
            node.bgcolor = style.bg;
            changed += 1;
        }
    }
    return changed;
}

function wfPlaceHelpersTop(data, assignedIds, originX, topY) {
    const helpers = (data.nodes || []).filter(
        n => WF_HELPER_TYPES.has(String(n.type)) && !assignedIds.has(Number(n.id))
    );
    if (!helpers.length) return [];
    helpers.sort((a, b) => (Number(a.pos?.[0]) || 0) - (Number(b.pos?.[0]) || 0) || (Number(a.pos?.[1]) || 0) - (Number(b.pos?.[1]) || 0));
    const maxHeight = Math.max(...helpers.map(n => snapUp(wfNodeSize(n)[1])));
    const y = snap(topY) - maxHeight - PAD;
    let cursor = snap(originX);
    for (const node of helpers) {
        const [w, h] = wfNodeSize(node);
        node.pos = [snap(cursor), snap(y + (maxHeight - h))];
        cursor += snapUp(w) + PAD;
    }
    return helpers;
}

function wfIsRerouteNode(node) {
    const t = String(node?.type || "");
    return t === "Reroute" || t === "Reroute (rgthree)" || t === "ReroutePrimitive" || /^Reroute\b/i.test(t);
}

function wfRemoveReroutes(data) {
    const nodes = data.nodes || [];
    const links = data.links || [];
    const rerouteNodes = nodes.filter(n => wfIsRerouteNode(n));
    if (!rerouteNodes.length) return 0;

    const rerouteIds = new Set(rerouteNodes.map(n => Number(n.id)));
    const byId = new Map(nodes.map(n => [Number(n.id), n]));
    const linkById = new Map();
    const incomingLinkByNode = new Map();

    for (const lk of links) {
        if (Array.isArray(lk) && lk.length >= 5) {
            const lid = Number(lk[0]);
            const dstId = Number(lk[3]);
            linkById.set(lid, lk);
            if (rerouteIds.has(dstId)) {
                incomingLinkByNode.set(dstId, lk);
            }
        }
    }

    for (const rn of rerouteNodes) {
        const rid = Number(rn.id);
        if (!incomingLinkByNode.has(rid)) {
            for (const inp of (rn.inputs || [])) {
                const lid = inp?.link;
                if (lid != null && linkById.has(Number(lid))) {
                    incomingLinkByNode.set(rid, linkById.get(Number(lid)));
                    break;
                }
            }
        }
    }

    const resolveOrigin = (startRerouteId) => {
        let curId = Number(startRerouteId);
        const visited = new Set([curId]);
        while (rerouteIds.has(curId)) {
            const inLk = incomingLinkByNode.get(curId);
            if (!inLk) return null;
            const srcId = Number(inLk[1]);
            const srcSlot = Number(inLk[2]);
            const ltype = inLk.length >= 6 ? inLk[5] : "*";
            if (!rerouteIds.has(srcId)) {
                return { srcId, srcSlot, ltype };
            }
            if (visited.has(srcId)) return null;
            visited.add(srcId);
            curId = srcId;
        }
        return null;
    };

    const linksToRemove = new Set();

    for (const lk of links) {
        if (!Array.isArray(lk) || lk.length < 5) continue;
        const lid = Number(lk[0]);
        const srcId = Number(lk[1]);
        const srcSlot = Number(lk[2]);
        const dstId = Number(lk[3]);
        const dstSlot = Number(lk[4]);

        if (rerouteIds.has(dstId)) {
            // Link entrando em um Reroute: remove da saída do nó de origem (se for nó real) e marca link para remoção
            linksToRemove.add(lid);
            if (!rerouteIds.has(srcId)) {
                const srcNode = byId.get(srcId);
                const outArr = srcNode?.outputs?.[srcSlot]?.links;
                if (Array.isArray(outArr)) {
                    const idx = outArr.indexOf(lid);
                    if (idx !== -1) outArr.splice(idx, 1);
                }
            }
        } else if (rerouteIds.has(srcId)) {
            // Link saindo de um Reroute para um nó real: religa direto na origem real (ou remove se órfão)
            const origin = resolveOrigin(srcId);
            const dstNode = byId.get(dstId);
            if (origin && byId.has(origin.srcId)) {
                lk[1] = origin.srcId;
                lk[2] = origin.srcSlot;
                const realSrcNode = byId.get(origin.srcId);
                const outObj = realSrcNode?.outputs?.[origin.srcSlot];
                if (outObj) {
                    if (!Array.isArray(outObj.links)) outObj.links = [];
                    if (!outObj.links.includes(lid)) outObj.links.push(lid);
                    if ((!lk[5] || lk[5] === "*") && outObj.type && outObj.type !== "*") {
                        lk[5] = outObj.type;
                    }
                }
                if ((!lk[5] || lk[5] === "*") && origin.ltype && origin.ltype !== "*") {
                    lk[5] = origin.ltype;
                }
            } else {
                linksToRemove.add(lid);
                if (dstNode?.inputs?.[dstSlot]) {
                    dstNode.inputs[dstSlot].link = null;
                }
            }
        }
    }

    data.links = links.filter(lk => !(Array.isArray(lk) && linksToRemove.has(Number(lk[0]))));
    data.nodes = nodes.filter(n => !rerouteIds.has(Number(n.id)));

    // Limpa referências residuais em grupos se houver
    for (const g of wfGetGroups(data)) {
        for (const k of ["getNodeIds", "setNodeIds", "foldNodes"]) {
            if (Array.isArray(g[k])) {
                g[k] = g[k].filter(id => !rerouteIds.has(Number(id?.id ?? id)));
            }
        }
    }
    return rerouteNodes.length;
}

function wfLayoutOnce(data, opts = {}) {
    const paint = opts.paint !== false;
    const regroup = Boolean(opts.regroup);
    const adopt = Boolean(opts.adopt);
    const wireSetGet = opts.wire_set_get !== false;
    const addOpt = opts.add_opt !== false;
    const auxRow = opts.aux_row !== false;
    const keepOrigin = opts.keep_origin !== false;
    const chainWithinStage = opts.chain_within_stage !== false;
    const bridgeTwoPass = opts.bridge_two_pass !== false;
    const helpersTop = opts.helpers_top !== false;

    const report = {
        regrouped: false,
        converted_evm: 0,
        reroutes_removed: 0,
        groups: 0,
        set_created: 0,
        get_created: 0,
        repainted: 0,
        optional_marked: [],
        ungrouped: [],
        adopted: [],
        dropped: [],
    };

    // Remove todos os nós Reroute reconectando seus links diretamente antes de organizar
    report.reroutes_removed = wfRemoveReroutes(data);

    if (regroup) {
        wfBuildGroups(data);
        report.regrouped = true;
    } else {
        report.converted_evm = wfEnsureEvmGroups(data);
        if (adopt) {
            report.adopted = wfAdoptLooseNodes(data);
        }
    }

    let groups = wfGetGroups(data);
    if (!groups.length && !(data.nodes || []).some(n => wfIsNoteNode(n))) return report;

    const assignment = wfAssignMembers(data, groups);

    // Garante que tudo que for nota (Note, MarkdownNote, etc.) esteja em um grupo de cor preta (NOTES)
    wfEnsureNotesGrouped(data, groups, assignment);

    let empty = groups.filter(g => !(assignment.get(g) || []).length);
    if (empty.length) {
        report.dropped = empty.map(g => g.title);
        groups = groups.filter(g => (assignment.get(g) || []).length > 0);
        wfSetGroups(data, groups);
    }
    if (!groups.length) return report;

    // Separa automaticamente grupos que misturam nós de INPUT (LoadImage/LoadAudio/etc.) com nós de OUTPUT (SaveImage/SaveVideo/etc.)
    wfSplitMixedInputOutputGroups(data, groups, assignment);

    const stageOf = wfStageMap(data, groups);
    for (const g of groups) {
        if (!g._stage) g._stage = stageOf.get(g) || WF_OTHER;
    }

    if (wireSetGet) {
        const [sc, gc] = wfWireSetGetBetweenGroups(data, groups, assignment);
        report.set_created = sc;
        report.get_created = gc;
    }

    const groupByNode = new Map();
    for (const [g, list] of assignment.entries()) {
        for (const n of list) groupByNode.set(Number(n.id), g);
    }

    let originX = 0;
    let originY = 0;
    if (keepOrigin && groups.length) {
        const nonNoteGroups = groups.filter(g => g._stage !== "NOTES");
        const refGroups = nonNoteGroups.length ? nonNoteGroups : groups;
        originX = snap(Math.min(...refGroups.map(g => wfGroupBox(g)[0])));
        originY = snap(Math.min(...refGroups.map(g => wfGroupBox(g)[1])));
    }

    const pipeline = groups.filter(g => g._stage !== WF_AUX && g._stage !== WF_OTHER);
    const aux = groups.filter(g => g._stage === WF_AUX);
    const other = groups.filter(g => g._stage === WF_OTHER);

    let topY = originY;
    if (auxRow && aux.length) {
        let cursorX = originX;
        let rowHeight = 0;
        for (const g of aux) {
            const bounding = wfTidyGroup(data, g, [cursorX, originY], assignment.get(g));
            cursorX = bounding[0] + bounding[2] + PAD;
            rowHeight = Math.max(rowHeight, bounding[3]);
        }
        topY = originY + rowHeight + PAD;
    }

    const byStage = new Map();
    for (const g of pipeline) {
        let st = g._stage;
        if (st === "INPUT" && wfHasAudioHint(g, assignment.get(g) || [])) {
            const gx = wfGroupBox(g)[0];
            const promptGroups = pipeline.filter(pg => pg._stage === "PROMPT");
            const inputGroups = pipeline.filter(ig => ig._stage === "INPUT" && ig !== g);
            if (promptGroups.length && inputGroups.length) {
                const distPrompt = Math.min(...promptGroups.map(pg => Math.abs(gx - wfGroupBox(pg)[0])));
                const distInput = Math.min(...inputGroups.map(ig => Math.abs(gx - wfGroupBox(ig)[0])));
                if (distPrompt < distInput) st = "PROMPT";
            }
        }
        if (!byStage.has(st)) byStage.set(st, []);
        byStage.get(st).push(g);
    }

    let columns = [];
    for (const stage of WF_STAGES) {
        const col = byStage.get(stage);
        if (!col || !col.length) continue;
        col.sort((a, b) => wfGroupBox(a)[1] - wfGroupBox(b)[1] || wfGroupBox(a)[0] - wfGroupBox(b)[0]);
        const level = chainWithinStage
            ? wfDependencyLevels(data, col, assignment, groupByNode)
            : new Map(col.map(g => [g, 0]));
        const byLevel = new Map();
        for (const g of col) {
            const lv = level.get(g) || 0;
            if (!byLevel.has(lv)) byLevel.set(lv, []);
            byLevel.get(lv).push(g);
        }
        for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
            const lvGroups = byLevel.get(lv);
            lvGroups.sort((a, b) => wfGroupBox(a)[1] - wfGroupBox(b)[1] || wfGroupBox(a)[0] - wfGroupBox(b)[0]);
            columns.push(lvGroups);
        }
    }

    if (bridgeTwoPass) {
        columns = wfChainColumns(data, pipeline, columns, groupByNode);
    }

    let cursorX = originX;
    for (const levelGroups of columns) {
        let levelWidth = 0;
        let cursorY = topY;
        for (const g of levelGroups) {
            const bounding = wfTidyGroup(data, g, [cursorX, cursorY], assignment.get(g));
            cursorY = bounding[1] + bounding[3] + PAD;
            levelWidth = Math.max(levelWidth, bounding[2]);
        }
        cursorX += levelWidth + PAD;
    }

    if (other.length) {
        let cursorY = topY;
        for (const g of other) {
            const bounding = wfTidyGroup(data, g, [cursorX, cursorY], assignment.get(g));
            cursorY = bounding[1] + bounding[3] + PAD;
        }
    }

    groups.forEach((g, idx) => {
        const stage = g._stage || WF_OTHER;
        delete g._stage;
        const members = assignment.get(g) || [];
        const color = wfGroupColorFor(stage, g, members);
        if (typeof g.id !== "string" || !g.id.startsWith("evmg_")) {
            g.id = `evmg_${stage.toLowerCase()}_${idx + 1}`;
        }
        g.color = color;
        g.titleColor = color;
        g.bodyColor = color;
        g.fontSize = DEF_FONT_SIZE;
        g._colorMigratedV2 = true;
        delete g.bounding;
        delete g.flags;
        delete g.titleAlpha;
        delete g.bodyAlpha;

        if (paint && stage !== WF_AUX && stage !== WF_OTHER) {
            report.repainted += wfPaintNodes(data, g, stage, members);
        }
        if (addOpt) {
            const centralM = members.filter(n => n.type !== "GetNode" && n.type !== "SetNode");
            const poolM = centralM.length ? centralM : members;
            if (poolM.length && !wfOptionalSuffix(g)) {
                const bypassed = poolM.filter(n => n.mode === 4).length;
                if (bypassed / poolM.length >= 0.6) {
                    g.title = wfMarkOptional(g.title);
                    report.optional_marked.push(g.title);
                }
            }
        }
    });

    const assignedIds = new Set();
    for (const list of assignment.values()) {
        for (const n of list) assignedIds.add(Number(n.id));
    }

    if (helpersTop) {
        const allBoxes = wfGetGroups(data).map(g => wfGroupBox(g));
        const shelfTop = allBoxes.length ? Math.min(...allBoxes.map(b => b[1])) : originY;
        wfPlaceHelpersTop(data, assignedIds, originX, shelfTop);
    }

    if (Array.isArray(data.nodes)) {
        const prio = (n) => {
            const t = String(n?.type || "");
            if (t === "SetNode") return 0;
            if (t === "GetNode") return 1;
            if (t === "ImpactSwitch" || t === "LatentSwitch" || t === "SEGSSwitch") return 3;
            return 2;
        };
        data.nodes.sort((a, b) => prio(a) - prio(b));
    }

    report.ungrouped = (data.nodes || []).filter(
        n => !assignedIds.has(Number(n.id)) && !WF_HELPER_TYPES.has(String(n.type))
    );
    wfSetGroups(data, groups);
    report.groups = groups.length;
    return report;
}

function wfRunOrganizerInJs(data, options = {}) {
    const hasGroups = (
        (Array.isArray(data?.groups) && data.groups.length > 0) ||
        (Array.isArray(data?.extra?.evmGroups) && data.extra.evmGroups.length > 0) ||
        (Array.isArray(data?.extra?.pixaromaGroups) && data.extra.pixaromaGroups.length > 0)
    );
    const mode = String(options.mode || "auto").toLowerCase();
    let regroup = false;
    let adopt = false;
    if (mode === "regroup") {
        regroup = true;
    } else if (mode === "adopt") {
        regroup = !hasGroups;
        adopt = hasGroups;
    } else if (mode === "existing") {
        regroup = false;
        adopt = false;
    } else {
        regroup = !hasGroups;
        adopt = hasGroups;
    }
    if ("regroup" in options) regroup = Boolean(options.regroup);
    if ("adopt" in options) adopt = Boolean(options.adopt);

    const pass1 = wfLayoutOnce(data, { ...options, regroup, adopt });
    const pass2 = wfLayoutOnce(data, { ...options, regroup: false, adopt: false });

    return {
        groups: pass2.groups,
        converted_evm: pass1.converted_evm,
        reroutes_removed: (pass1.reroutes_removed || 0) + (pass2.reroutes_removed || 0),
        regrouped: pass1.regrouped,
        adopted: pass1.adopted,
        set_created: (pass1.set_created || 0) + (pass2.set_created || 0),
        get_created: (pass1.get_created || 0) + (pass2.get_created || 0),
        repainted: Math.max(pass1.repainted || 0, pass2.repainted || 0),
        optional_marked: [...new Set([...(pass1.optional_marked || []), ...(pass2.optional_marked || [])])],
        dropped: [...(pass1.dropped || []), ...(pass2.dropped || [])],
        ungrouped_count: (pass2.ungrouped || []).length,
    };
}

function applySerializedWorkflowInPlace(gr, data, preserveView = true) {
    if (!gr || !data) return;
    const prevScale = app.canvas?.ds?.scale;
    const prevOffset = app.canvas?.ds?.offset
        ? [app.canvas.ds.offset[0], app.canvas.ds.offset[1]]
        : null;

    gr.configure(data);

    // Sincroniza SetNode / GetNode recém-criados (KJNodes)
    const allNodes = gr._nodes || [];
    for (const n of allNodes) {
        if (n && n.type === "SetNode") {
            try { n.onRename?.(); } catch (_e) {}
            try { n.update?.(); } catch (_e) {}
        }
    }
    for (const n of allNodes) {
        if (n && n.type === "GetNode") {
            try { n.onRename?.(); } catch (_e) {}
            try { n.update?.(); } catch (_e) {}
        }
    }

    // Garante que widgets DOM customizados respeitem a altura mínima renderizada no navegador
    const groups = [...ensureEvmGroups(gr)].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    for (const g of groups) {
        ensureDockArrays(g);
        const cNodes = getCentralMemberNodes(g, gr);
        for (const cn of cNodes) {
            if (!cn.flags?.collapsed && typeof cn.computeSize === "function" && cn.size) {
                try {
                    const minSz = cn.computeSize();
                    if (Array.isArray(minSz) && minSz[1] > cn.size[1]) {
                        cn.size[1] = snapUp(minSz[1]);
                    }
                } catch (_e) {}
            }
        }
        tidyGroupCentralNodes(g, gr, cNodes);
        syncGroupLayoutSignature(g, gr, cNodes);
    }

    if (preserveView && app.canvas?.ds) {
        if (typeof prevScale === "number" && Number.isFinite(prevScale)) {
            app.canvas.ds.scale = prevScale;
        }
        if (prevOffset) {
            app.canvas.ds.offset[0] = prevOffset[0];
            app.canvas.ds.offset[1] = prevOffset[1];
        }
    }

    invalidateHidden();
    updateHideCSS();
    markChanged();
    repaint();
}

function organizeCurrentWorkflow(options = {}) {
    if (_organizeBusy) return;
    const gr = curGraph();
    if (!gr) return;

    const snapshot = gr.serialize();
    if (!snapshot || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length) {
        toast("Organizar Workflow", "O canvas atual não possui nós para organizar.");
        return;
    }

    _organizeBusy = true;
    try {
        const undoCopy = JSON.parse(JSON.stringify(snapshot));
        const workData = JSON.parse(JSON.stringify(snapshot));

        const rep = wfRunOrganizerInJs(workData, options);

        _organizeUndoStack.push(undoCopy);
        if (_organizeUndoStack.length > 10) _organizeUndoStack.shift();

        applySerializedWorkflowInPlace(gr, workData, options.keep_origin !== false);

        const parts = [`${rep.groups ?? 0} grupos`];
        if (rep.set_created || rep.get_created) {
            parts.push(`+${rep.set_created || 0} Set / +${rep.get_created || 0} Get`);
        }
        if (Array.isArray(rep.adopted) && rep.adopted.length) {
            const totalAdopted = rep.adopted.reduce((acc, it) => acc + (Number(it.count) || 0), 0);
            if (totalAdopted > 0) parts.push(`${totalAdopted} adotados`);
        }
        if (rep.repainted) {
            parts.push(`${rep.repainted} pintados`);
        }
        toast("⚡ Workflow Organizado", parts.join(" • "));
        console.info("[ComfyUI-EVM-Advanced-Group] Relatório de organização (100% JS):", rep);
    } catch (err) {
        console.error("[ComfyUI-EVM-Advanced-Group] Falha ao organizar workflow:", err);
        toast("Erro ao organizar workflow", String(err?.message || err));
    } finally {
        _organizeBusy = false;
    }
}

function undoLastWorkflowOrganize() {
    const gr = curGraph();
    if (!gr || !_organizeUndoStack.length) {
        toast("Desfazer Organização", "Nenhum estado anterior disponível.");
        return;
    }
    const prev = _organizeUndoStack.pop();
    applySerializedWorkflowInPlace(gr, prev, true);
    toast("↩️ Organização Revertida", "O layout anterior do workflow foi restaurado.");
}

// ── Definições da Tela de Configurações Nativa do ComfyUI (⚡ EVM Group) ──────
const COLOR_OPTIONS_MAP = {
    "Pale Blue (Padrão ComfyUI)": "#3f789e",
    "Red": "#aa8888",
    "Brown": "#b06634",
    "Green": "#88aa88",
    "Blue": "#8888aa",
    "Cyan": "#88aaaa",
    "Purple": "#a1309b",
    "Yellow": "#b58b2a",
    "Black": "#444444",
};

const HEADER_VIS_MAP = {
    "Sempre visíveis (Run, Mute, Bypass, Fold)": "always",
    "Compacto (apenas Fold)": "compact",
    "Mostrar extras ao passar o mouse / selecionar": "hover",
};

const EVM_SETTINGS_DEFS = [
    // 1. Layout & Grade (Grid = 10px)
    {
        id: "EVMGroup.Layout.PaddingSquares",
        name: "Margem interna do grupo (em quadradinhos da grade de 10px)",
        type: "slider",
        attrs: { min: 1, max: 8, step: 1 },
        defaultValue: 3,
        tooltip: "Distância entre as bordas/cabeçalho do grupo e os nodes internos (padrão: 3 quadradinhos = 30px).",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Margem Interna"],
        onChange: (val) => {
            const sq = Math.max(1, Math.min(10, Number(val) || 3));
            PAD = sq * GRID;
            recalcDerivedGeometry();
            refreshAllGroupsLayout();
        },
    },
    {
        id: "EVMGroup.Layout.VerticalGapSquares",
        name: "Espaçamento vertical entre nodes (em quadradinhos da grade)",
        type: "slider",
        attrs: { min: 1, max: 8, step: 1 },
        defaultValue: 3,
        tooltip: "Espaço livre vertical entre o fim de um node e o topo da barra de título do node debaixo (padrão: 3 quadradinhos = 30px livres + 30px do título = 60px).",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Gap Vertical"],
        onChange: (val) => {
            const sq = Math.max(1, Math.min(10, Number(val) || 3));
            NODE_VGAP = sq * GRID + NODE_TITLE_H;
            refreshAllGroupsLayout();
        },
    },
    {
        id: "EVMGroup.Layout.HorizontalGapSquares",
        name: "Espaçamento horizontal entre colunas (em quadradinhos da grade)",
        type: "slider",
        attrs: { min: 1, max: 10, step: 1 },
        defaultValue: 3,
        tooltip: "Distância horizontal entre colunas de nodes dentro da Área Central do grupo (padrão: 3 quadradinhos = 30px).",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Gap Horizontal"],
        onChange: (val) => {
            const sq = Math.max(1, Math.min(12, Number(val) || 3));
            NODE_HGAP = sq * GRID;
            refreshAllGroupsLayout();
        },
    },
    {
        id: "EVMGroup.Layout.ColumnThreshold",
        name: "Tolerância horizontal para agrupar na mesma coluna (px)",
        type: "slider",
        attrs: { min: 30, max: 240, step: 10 },
        defaultValue: 100,
        tooltip: "Diferença máxima no eixo X (em pixels) para considerar que dois nodes pertencem à mesma coluna vertical.",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Tolerância de Coluna"],
        onChange: (val) => {
            COL_THRESHOLD = Math.max(20, Number(val) || 100);
            refreshAllGroupsLayout();
        },
    },
    {
        id: "EVMGroup.Layout.AutoReflow",
        name: "Auto-Reflow dinâmico ao redimensionar ou minimizar/maximizar nodes",
        type: "boolean",
        defaultValue: true,
        tooltip: "Quando ativo, redimensionar ou minimizar/maximizar qualquer node reposiciona os vizinhos automaticamente e ajusta o tamanho do grupo em tempo real.",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Auto-Reflow Dinâmico"],
        onChange: (val) => {
            EVM_CFG.autoReflow = Boolean(val);
            if (EVM_CFG.autoReflow) refreshAllGroupsLayout();
        },
    },
    {
        id: "EVMGroup.Layout.PushNeighborsOnExpand",
        name: "Empurrar grupos vizinhos automaticamente ao expandir (Anti-Colisão)",
        type: "boolean",
        defaultValue: true,
        tooltip: "Quando um grupo cresce lateralmente ou verticalmente (por resize de node, abertura de painel Get/Set, desdobramento ou resize manual), desloca em cascata os grupos vizinhos e todos os seus nodes para evitar sobreposição.",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Anti-Colisão entre Grupos"],
        onChange: (val) => {
            EVM_CFG.pushNeighborsOnExpand = Boolean(val);
        },
    },
    {
        id: "EVMGroup.Layout.SnapToGrid",
        name: "Alinhar coordenadas automaticamente à grade do ComfyUI (10px)",
        type: "boolean",
        defaultValue: true,
        tooltip: "Garante que posição e tamanho dos grupos e nodes fiquem alinhados em múltiplos exatos de 10px.",
        category: ["⚡ EVM Advanced Group", "1. Layout & Grade", "Snap to Grid"],
        onChange: (val) => {
            EVM_CFG.snapToGrid = Boolean(val);
            refreshAllGroupsLayout();
        },
    },

    // 2. Painéis Set / Get
    {
        id: "EVMGroup.Rails.DefaultLeftOpen",
        name: "Iniciar novos grupos com o painel esquerdo (GetNode) aberto",
        type: "boolean",
        defaultValue: true,
        tooltip: "Define se o trilho esquerdo de entrada (GetNode) já vem visível ao criar um novo EVM Advanced Group.",
        category: ["⚡ EVM Advanced Group", "2. Painéis Set / Get", "Painel Esquerdo (GetNode)"],
        onChange: (val) => {
            EVM_CFG.defaultLeftOpen = Boolean(val);
        },
    },
    {
        id: "EVMGroup.Rails.DefaultRightOpen",
        name: "Iniciar novos grupos com o painel direito (SetNode) aberto",
        type: "boolean",
        defaultValue: true,
        tooltip: "Define se o trilho direito de saída (SetNode) já vem visível ao criar um novo EVM Advanced Group.",
        category: ["⚡ EVM Advanced Group", "2. Painéis Set / Get", "Painel Direito (SetNode)"],
        onChange: (val) => {
            EVM_CFG.defaultRightOpen = Boolean(val);
        },
    },
    {
        id: "EVMGroup.Rails.MinRailInnerWidth",
        name: "Largura interna mínima dos painéis Set/Get (px)",
        type: "slider",
        attrs: { min: 100, max: 260, step: 10 },
        defaultValue: 140,
        tooltip: "Largura mínima útil do painel lateral quando vazio ou com nomes curtos (o painel sempre se expande automaticamente para nomes longos).",
        category: ["⚡ EVM Advanced Group", "2. Painéis Set / Get", "Largura Mínima dos Painéis"],
        onChange: (val) => {
            MIN_RAIL_INNER_W = Math.max(90, Number(val) || 140);
            recalcDerivedGeometry();
            refreshAllGroupsLayout();
        },
    },
    {
        id: "EVMGroup.Rails.AutoNamingFormat",
        name: "Formato de nomenclatura automática do SetNode ao conectar fio",
        type: "combo",
        options: ["<Grupo>_<TIPO>", "<TIPO>_<Grupo>", "Desativado"],
        defaultValue: "<Grupo>_<TIPO>",
        tooltip: "Padrão usado para batizar automaticamente o SetNode ancorado quando um fio é conectado a ele.",
        category: ["⚡ EVM Advanced Group", "2. Painéis Set / Get", "Formato de Auto-Nomenclatura"],
        onChange: (val) => {
            EVM_CFG.autoNamingFormat = String(val || "<Grupo>_<TIPO>");
        },
    },
    {
        id: "EVMGroup.Rails.SyncRenameOnGroupTitle",
        name: "Renomear SetNodes e GetNodes pareados ao renomear o título do grupo",
        type: "boolean",
        defaultValue: true,
        tooltip: "Quando ativo, alterar o nome do EVM Advanced Group atualiza automaticamente o prefixo de todos os SetNodes ancorados naquele grupo e os GetNodes correspondentes no workflow.",
        category: ["⚡ EVM Advanced Group", "2. Painéis Set / Get", "Sincronizar Renomeação"],
        onChange: (val) => {
            EVM_CFG.syncRenameOnGroupTitle = Boolean(val);
        },
    },

    // 3. Aparência & Cabeçalho
    {
        id: "EVMGroup.Appearance.DefaultColor",
        name: "Cor padrão ao criar novos EVM Advanced Groups (Paleta ComfyUI)",
        type: "combo",
        options: Object.keys(COLOR_OPTIONS_MAP),
        defaultValue: "Pale Blue (Padrão ComfyUI)",
        tooltip: "Cor inicial aplicada a novos grupos criados (usa a paleta oficial LGraphCanvas.node_colors do ComfyUI).",
        category: ["⚡ EVM Advanced Group", "3. Aparência & Cabeçalho", "Cor Padrão"],
        onChange: (val) => {
            DEFAULT_GROUP_COLOR = COLOR_OPTIONS_MAP[val] || "#3f789e";
            repaint();
        },
    },
    {
        id: "EVMGroup.Appearance.DefaultFontSize",
        name: "Tamanho padrão da fonte do título (px)",
        type: "slider",
        attrs: { min: 12, max: 24, step: 1 },
        defaultValue: 16,
        tooltip: "Tamanho da fonte exibida na barra de título superior do EVM Advanced Group.",
        category: ["⚡ EVM Advanced Group", "3. Aparência & Cabeçalho", "Tamanho da Fonte"],
        onChange: (val) => {
            DEF_FONT_SIZE = Math.max(10, Math.min(28, Number(val) || 16));
            for (const g of ensureEvmGroups()) {
                g.fontSize = DEF_FONT_SIZE;
            }
            repaint();
        },
    },
    {
        id: "EVMGroup.Appearance.TitleOpacity",
        name: "Opacidade da barra de título do grupo (%)",
        type: "slider",
        attrs: { min: 25, max: 100, step: 5 },
        defaultValue: 78,
        tooltip: "Transparência da barra de cabeçalho superior do EVM Advanced Group.",
        category: ["⚡ EVM Advanced Group", "3. Aparência & Cabeçalho", "Opacidade do Título"],
        onChange: (val) => {
            DEF_TITLE_ALPHA = Math.max(0.15, Math.min(1, (Number(val) || 78) / 100));
            repaint();
        },
    },
    {
        id: "EVMGroup.Appearance.BodyOpacity",
        name: "Opacidade do fundo do corpo do grupo (%)",
        type: "slider",
        attrs: { min: 5, max: 65, step: 5 },
        defaultValue: 22,
        tooltip: "Transparência do preenchimento interno do grupo.",
        category: ["⚡ EVM Advanced Group", "3. Aparência & Cabeçalho", "Opacidade do Corpo"],
        onChange: (val) => {
            DEF_BODY_ALPHA = Math.max(0.03, Math.min(0.85, (Number(val) || 22) / 100));
            repaint();
        },
    },
    {
        id: "EVMGroup.Appearance.HeaderButtons",
        name: "Exibição dos botões de ação no cabeçalho (Run, Mute, Bypass, Fold)",
        type: "combo",
        options: Object.keys(HEADER_VIS_MAP),
        defaultValue: "Sempre visíveis (Run, Mute, Bypass, Fold)",
        tooltip: "Controla quais botões aparecem no canto superior direito do cabeçalho do EVM Advanced Group.",
        category: ["⚡ EVM Advanced Group", "3. Aparência & Cabeçalho", "Botões do Cabeçalho"],
        onChange: (val) => {
            EVM_CFG.headerBtnVis = HEADER_VIS_MAP[val] || "always";
            repaint();
        },
    },
    {
        id: "EVMGroup.Appearance.ShowLinksWhenFolded",
        name: "Exibir conexões externas quando o grupo estiver recolhido (Folded)",
        type: "boolean",
        defaultValue: true,
        tooltip: "Mantém visíveis as linhas de ligação que entram ou saem de um EVM Advanced Group recolhido.",
        category: ["⚡ EVM Advanced Group", "3. Aparência & Cabeçalho", "Conexões Quando Recolhido"],
        onChange: (val) => {
            EVM_CFG.showLinksWhenFolded = Boolean(val);
            for (const g of ensureEvmGroups()) {
                g.showLinks = EVM_CFG.showLinksWhenFolded;
            }
            repaint();
        },
    },

    // 4. Barra de Ações (Selection Toolbox)
    {
        id: "EVMGroup.Toolbox.ShowFloatingToolbar",
        name: "Exibir barra flutuante de ações ao selecionar um grupo (Cor, Delete, Fold)",
        type: "boolean",
        defaultValue: true,
        tooltip: "Mostra a barra pílula flutuante acima do EVM Advanced Group ou Pixaroma Group selecionado.",
        category: ["⚡ EVM Advanced Group", "4. Barra de Ações (Toolbox)", "Barra Flutuante do Grupo"],
        onChange: (val) => {
            EVM_CFG.showFloatingToolbar = Boolean(val);
            const bar = document.getElementById("evm-group-floating-bar");
            if (bar && !EVM_CFG.showFloatingToolbar) bar.style.display = "none";
        },
    },
    {
        id: "EVMGroup.Toolbox.ShowConvertInNativeToolbox",
        name: "Exibir botão 'EVM Group' na Selection Toolbox nativa do ComfyUI",
        type: "boolean",
        defaultValue: true,
        tooltip: "Adiciona o botão pílula 'EVM Group' na barra de seleção nativa do ComfyUI ao selecionar nodes ou grupos.",
        category: ["⚡ EVM Advanced Group", "4. Barra de Ações (Toolbox)", "Botão na Selection Toolbox Nativa"],
        onChange: (val) => {
            EVM_CFG.showConvertInNativeToolbox = Boolean(val);
        },
    },
];

// ── Integração com a Selection Toolbox Nativa e Barra Flutuante Própria ─────
const EVM_RESIZE_TOOLBOX_CMD = "evm.selectionToolbox.resize";
const EVM_CLEAR_COLOR_TOOLBOX_CMD = "evm.selectionToolbox.clearColor";
const EVM_GROUP_TOOLBOX_CMD = "evm.selectionToolbox.evmGroup";

function clearSelectionColors() {
    const gr = curGraph();
    if (!gr || !app.canvas) return;
    let changed = false;

    const clearNodeColor = (n) => {
        if (!n || typeof n !== "object") return;
        if (n.color !== undefined || n.bgcolor !== undefined) {
            delete n.color;
            delete n.bgcolor;
            changed = true;
        }
    };

    // 1. Limpa cores dos nós diretamente selecionados
    if (app.canvas.selected_nodes && typeof app.canvas.selected_nodes === "object") {
        const vals = Array.isArray(app.canvas.selected_nodes)
            ? app.canvas.selected_nodes
            : Object.values(app.canvas.selected_nodes);
        for (const n of vals) clearNodeColor(n);
    }
    if (app.canvas.selectedItems && typeof app.canvas.selectedItems[Symbol.iterator] === "function") {
        for (const it of app.canvas.selectedItems) {
            if (it && it.id != null && it.pos && it.size) clearNodeColor(it);
        }
    }
    for (const n of (gr._nodes || [])) {
        if (n?.selected) clearNodeColor(n);
    }

    // 2. Limpa cores de EVM Groups selecionados (grupo + nós internos)
    const evmGroups = getSelectedEvmGroups();
    for (const g of evmGroups) {
        if (!g) continue;
        setEvmGroupColor(g, null);
        for (const n of groupMemberNodes(g)) clearNodeColor(n);
        changed = true;
    }

    // 3. Limpa cores de Grupos Nativos selecionados (grupo + nós internos)
    const natGroups = getResizeableSelectedNativeGroups();
    for (const g of natGroups) {
        if (!g) continue;
        g.color = DEFAULT_GROUP_COLOR;
        try { g.recomputeInsideNodes?.(); } catch (_e) {}
        const inside = g._nodes || g.nodes || [];
        if (Array.isArray(inside) && inside.length) {
            for (const n of inside) clearNodeColor(n);
        } else {
            const b = g.boundingRect || g._bounding || g.bounding;
            const pos = b ? [b[0], b[1]] : (g._pos || g.pos || [0, 0]);
            const sz = b ? [b[2], b[3]] : (g._size || g.size || [0, 0]);
            for (const n of (gr._nodes || [])) {
                if (!n || !n.pos) continue;
                const vb = nodeVisualBounds(n);
                const cx = vb.x + vb.w / 2;
                const cy = vb.y + vb.h / 2;
                if (cx >= pos[0] && cx <= pos[0] + sz[0] && cy >= pos[1] && cy <= pos[1] + sz[1]) {
                    clearNodeColor(n);
                }
            }
        }
        changed = true;
    }

    // 4. Limpa cores de Pixaroma Groups selecionados (grupo + nós internos)
    let pixGroups = [];
    if (window.PixaromaPixGroup) {
        try {
            const pgs = window.PixaromaPixGroup.getSelectedGroups?.() || [];
            if (pgs.length) pixGroups.push(...pgs);
            else {
                const pg = window.PixaromaPixGroup.getSelected?.();
                if (pg) pixGroups.push(pg);
            }
        } catch (_e) {}
    }
    if (!pixGroups.length && Array.isArray(gr.extra?.pixaromaGroups)) {
        pixGroups = gr.extra.pixaromaGroups.filter(g => g && (g.selected || g._selected));
    }
    for (const pg of pixGroups) {
        pg.color = DEFAULT_GROUP_COLOR;
        pg.titleColor = DEFAULT_GROUP_COLOR;
        pg.bodyColor = DEFAULT_GROUP_COLOR;
        for (const n of (gr._nodes || [])) {
            if (!n || !n.pos) continue;
            const vb = nodeVisualBounds(n);
            const cx = vb.x + vb.w / 2;
            const cy = vb.y + vb.h / 2;
            if (cx >= pg.x && cx <= pg.x + pg.w && cy >= pg.y && cy <= pg.y + pg.h) {
                clearNodeColor(n);
            }
        }
        window.PixaromaPixGroup?.repaint?.();
        changed = true;
    }

    if (changed) {
        markChanged();
        repaint();
    }
}

const EVM_SVG_EQUAL_WIDTH = `<svg viewBox="0 0 32 32" width="18" height="18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="9" y="9" width="14" height="6" rx="1" ry="1" fill="currentColor"/>
    <rect x="11" y="19" width="10" height="6" rx="1" ry="1" fill="currentColor"/>
    <rect x="4" y="4" width="2" height="24" rx="1" fill="currentColor"/>
    <rect x="26" y="4" width="2" height="24" rx="1" fill="currentColor"/>
    <rect x="4" y="21" width="5" height="2" rx="1" fill="currentColor"/>
    <rect x="23" y="21" width="5" height="2" rx="1" fill="currentColor"/>
</svg>`;

const EVM_SVG_EQUAL_HEIGHT = `<svg viewBox="0 0 32 32" width="18" height="18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="18" y="9" width="6" height="14" rx="1" ry="1" fill="currentColor"/>
    <rect x="8" y="11" width="6" height="10" rx="1" ry="1" fill="currentColor"/>
    <rect x="4" y="4" width="24" height="2" rx="1" fill="currentColor"/>
    <rect x="4" y="26" width="24" height="2" rx="1" fill="currentColor"/>
    <rect x="10" y="4" width="2" height="5" rx="1" fill="currentColor"/>
    <rect x="10" y="23" width="2" height="5" rx="1" fill="currentColor"/>
</svg>`;

let _evmResizePopoverEl = null;

function getResizeableSelectedNodes() {
    const gr = curGraph();
    if (!gr || !app.canvas) return [];
    const seen = new Set();
    const rawList = [];
    const hiddenSet = hiddenMaps().hidden;

    const addNode = (n) => {
        if (!n || typeof n !== "object" || n.id == null || !n.pos || !n.size) return;
        const sid = String(n.id);
        if (seen.has(sid)) return;
        if (!Array.isArray(gr._nodes) || !gr._nodes.includes(n)) return;
        if (n.type === "Reroute" || n.type === "Reroute (rgthree)") return;
        if (n.properties?.__denoVisualFold && n.properties.__denoVisualFold.index !== 0) return;
        if (hiddenSet.has(sid)) return;
        seen.add(sid);
        rawList.push(n);
    };

    if (app.canvas.selected_nodes && typeof app.canvas.selected_nodes === "object") {
        const vals = Array.isArray(app.canvas.selected_nodes)
            ? app.canvas.selected_nodes
            : Object.values(app.canvas.selected_nodes);
        for (const n of vals) addNode(n);
    }
    if (app.canvas.selectedItems && typeof app.canvas.selectedItems[Symbol.iterator] === "function") {
        for (const it of app.canvas.selectedItems) addNode(it);
    }
    for (const n of (gr._nodes || [])) {
        if (n?.selected) addNode(n);
    }

    // Se houver 2 ou mais nós regulares (não SetNode/GetNode) selecionados, ignora SetNode/GetNode
    // para que seleções amplas por caixa (marquee) dentro de um EVM Group igualem todos os nós
    // centrais (mesmo > 3 nós) sem serem afetadas pelos SetNode/GetNode ancorados nas laterais.
    const regularNodes = rawList.filter(n => n.type !== "SetNode" && n.type !== "GetNode");
    if (regularNodes.length >= 2) return regularNodes;
    return rawList;
}

function getResizeableSelectedNativeGroups() {
    const gr = curGraph();
    if (!gr || !app.canvas) return [];
    const groups = gr._groups || gr.groups || [];
    if (!Array.isArray(groups)) return [];
    const out = [];
    const addG = (g) => {
        if (g && groups.includes(g) && !out.includes(g)) out.push(g);
    };
    if (app.canvas.selectedItems && typeof app.canvas.selectedItems[Symbol.iterator] === "function") {
        for (const it of app.canvas.selectedItems) addG(it);
    }
    addG(app.canvas.selected_group);
    addG(app.canvas.selectedGroup);
    for (const g of groups) {
        if (g?.selected) addG(g);
    }
    return out;
}

function canResizeCurrentSelection() {
    if (getResizeableSelectedNodes().length >= 2) return true;
    if (getSelectedEvmGroups().length >= 2) return true;
    if (getResizeableSelectedNativeGroups().length >= 2) return true;
    return false;
}

function runEvmEqualizeSize(mode) {
    hideEvmResizePopover();
    const gr = curGraph();
    if (!gr || !app.canvas) return;

    const isWidth = mode === "width";
    const axis = isWidth ? 0 : 1;

    // 1. Prioridade para nós selecionados (>= 2 nós, sem qualquer limite máximo de quantidade!)
    const selNodes = getResizeableSelectedNodes();
    if (selNodes.length >= 2) {
        const activeNodes = selNodes.filter(n => !n.flags?.collapsed);
        const targetList = activeNodes.length >= 2 ? activeNodes : selNodes;
        const validSizes = targetList
            .map(n => Number(n.size?.[axis] || 0))
            .filter(v => Number.isFinite(v) && v > 0);
        if (!validSizes.length) return;

        const maxSize = snapUp(Math.max(...validSizes));
        const resizedSet = new Set();

        for (const n of targetList) {
            const curW = Number(n.size?.[0] || 140);
            const curH = Number(n.size?.[1] || 60);
            const nextW = isWidth ? maxSize : curW;
            const nextH = isWidth ? curH : maxSize;

            if (typeof n.setSize === "function") {
                try { n.setSize([nextW, nextH]); } catch (_e) {}
            }
            if (isVueNodes()) {
                n.size = [nextW, nextH];
            } else if (n.size) {
                n.size[0] = nextW;
                n.size[1] = nextH;
            } else {
                n.size = [nextW, nextH];
            }
            n._evmPrevW = Math.round(nextW);
            n._evmPrevBodyH = Math.round(nextH);
            try { n.onResize?.(n.size); } catch (_e) {}
            resizedSet.add(n);
        }

        // Atualiza e faz reflow automático dos EVM Groups que contenham os nós redimensionados
        for (const g of ensureEvmGroups(gr)) {
            if (!g || g.folded) continue;
            const cNodes = getCentralMemberNodes(g, gr);
            if (cNodes.some(cn => resizedSet.has(cn))) {
                tidyGroupCentralNodes(g, gr, cNodes);
                syncGroupLayoutSignature(g, gr, cNodes);
            }
        }

        markChanged();
        return;
    }

    // 2. Se não houver >= 2 nós selecionados, verifica >= 2 EVM Groups selecionados
    const evmGroups = getSelectedEvmGroups().filter(g => g && !g.folded);
    if (evmGroups.length >= 2) {
        if (isWidth) {
            const maxW = snapUp(Math.max(...evmGroups.map(g => Number(g.w || 0))));
            for (const g of evmGroups) {
                const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };
                g.w = Math.max(minGroupWidth(g), maxW);
                layoutDockedNodes(g, gr, { prevBounds });
            }
        } else {
            const maxH = snapUp(Math.max(...evmGroups.map(g => Number(g.h || 0))));
            for (const g of evmGroups) {
                const prevBounds = { x: g.x, y: g.y, w: g.w, h: g.h };
                g.h = Math.max(MIN_GROUP_H, maxH);
                layoutDockedNodes(g, gr, { prevBounds });
            }
        }
        markChanged();
        return;
    }

    // 3. Fallback: >= 2 Grupos Nativos do ComfyUI selecionados
    const natGroups = getResizeableSelectedNativeGroups();
    if (natGroups.length >= 2) {
        const getGSize = (g) => {
            const b = g.boundingRect || g._bounding || g.bounding;
            if (b && b.length >= 4) return [Number(b[2] || 0), Number(b[3] || 0)];
            const s = g.size || g._size || [0, 0];
            return [Number(s[0] || 0), Number(s[1] || 0)];
        };
        const maxVal = Math.max(...natGroups.map(g => getGSize(g)[axis]));
        if (Number.isFinite(maxVal) && maxVal > 0) {
            for (const g of natGroups) {
                const b = g.boundingRect || g._bounding || g.bounding;
                if (b && b.length >= 4) b[axis + 2] = maxVal;
                if (g.size && g.size.length >= 2) g.size[axis] = maxVal;
                if (g._size && g._size.length >= 2) g._size[axis] = maxVal;
            }
            markChanged();
        }
    }
}

function ensureEvmResizePopover() {
    if (_evmResizePopoverEl || typeof document === "undefined") return _evmResizePopoverEl;
    _evmResizePopoverEl = document.createElement("div");
    _evmResizePopoverEl.id = "evm-resize-popover-menu";
    _evmResizePopoverEl.className = "evm-resize-popover-menu";
    _evmResizePopoverEl.setAttribute("role", "menu");
    _evmResizePopoverEl.innerHTML = `
        <button type="button" class="evm-resize-popover-item" data-resize-mode="width" title="Igualar Largura (Horizontal) pelo maior selecionado">
            <span class="evm-resize-popover-icon">${EVM_SVG_EQUAL_WIDTH}</span>
            <span>Horizontal</span>
        </button>
        <button type="button" class="evm-resize-popover-item" data-resize-mode="height" title="Igualar Altura (Vertical) pelo maior selecionado">
            <span class="evm-resize-popover-icon">${EVM_SVG_EQUAL_HEIGHT}</span>
            <span>Vertical</span>
        </button>
    `;

    for (const btn of _evmResizePopoverEl.querySelectorAll(".evm-resize-popover-item")) {
        btn.addEventListener("pointerdown", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });
        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const mode = btn.getAttribute("data-resize-mode");
            if (mode) runEvmEqualizeSize(mode);
        });
    }

    document.body.appendChild(_evmResizePopoverEl);

    document.addEventListener("pointerdown", (ev) => {
        if (!_evmResizePopoverEl || _evmResizePopoverEl.style.display === "none") return;
        if (_evmResizePopoverEl.contains(ev.target)) return;
        if (ev.target?.closest?.("button:has(.evm-toolbox-resize-pill-icon), #evm-group-floating-bar .evm-btn-resize")) return;
        hideEvmResizePopover();
    }, true);

    window.addEventListener("resize", hideEvmResizePopover, { passive: true });
    return _evmResizePopoverEl;
}

function hideEvmResizePopover() {
    if (_evmResizePopoverEl) {
        _evmResizePopoverEl.style.display = "none";
    }
}

function showEvmResizePopover(anchorEl = null) {
    const menu = ensureEvmResizePopover();
    if (!menu) return;

    // Fecha o menu Align do Deno se estiver aberto ao lado
    const denoAlignMenu = document.querySelector(".deno-visual-align-menu");
    if (denoAlignMenu && denoAlignMenu.style.display !== "none") {
        denoAlignMenu.style.display = "none";
    }

    const btnEl = anchorEl ||
        document.querySelector("button:has(.evm-toolbox-resize-pill-icon)") ||
        document.querySelector("#evm-group-floating-bar .evm-btn-resize");

    menu.style.display = "grid";
    const menuRect = menu.getBoundingClientRect();
    const menuW = menuRect.width || 224;
    const menuH = menuRect.height || 48;

    let left = window.innerWidth / 2 - menuW / 2;
    let top = 80;

    if (btnEl) {
        const r = btnEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            left = r.left + r.width / 2 - menuW / 2;
            top = r.bottom + 8;
        }
    }

    left = Math.max(8, Math.min(window.innerWidth - menuW - 8, Math.round(left)));
    top = Math.max(8, Math.min(window.innerHeight - menuH - 8, Math.round(top)));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function toggleEvmResizePopover(anchorEl = null) {
    if (_evmResizePopoverEl && _evmResizePopoverEl.style.display === "grid") {
        hideEvmResizePopover();
    } else {
        showEvmResizePopover(anchorEl);
    }
}

function triggerCreateOrConvertFromSelection() {
    if (!app.canvas) return;
    // 1. Verifica Pixaroma Group selecionado
    let pixGroup = null;
    if (window.PixaromaPixGroup) {
        try {
            pixGroup = window.PixaromaPixGroup.getSelected?.() ||
                       (window.PixaromaPixGroup.getSelectedGroups?.() || [])[0] ||
                       null;
        } catch (_e) {}
    }
    if (!pixGroup) {
        const gs = curGraph()?.extra?.pixaromaGroups;
        if (Array.isArray(gs)) pixGroup = gs.find(g => g && (g.selected || g._selected));
    }
    if (pixGroup) {
        convertPixaromaGroupToEvm(pixGroup);
        return;
    }

    // 2. Verifica Grupo Nativo (LGraphGroup)
    let nativeGroup = app.canvas.selected_group;
    if (!nativeGroup && app.canvas.selectedItems) {
        for (const item of app.canvas.selectedItems) {
            if (item && (item._nodes || item.isGroup || (item.pos && item.size && !item.widgets && !item.inputs && !item.outputs && !item.id))) {
                nativeGroup = item;
                break;
            }
        }
    }
    if (!nativeGroup && app.graph?._groups) {
        nativeGroup = app.graph._groups.find(g => g.selected);
    }
    if (nativeGroup) {
        convertNativeGroupToEvm(nativeGroup);
        return;
    }

    // 3. Cria EVM Group com os nós selecionados
    createEvmGroup(null);
}

function initEvmGroupFloatingBar() {
    if (document.getElementById("evm-group-floating-bar")) return;

    const styleId = "evm-group-floating-bar-styles";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            .evm-toolbox-resize-pill-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 48px;
                height: 22px;
                box-sizing: border-box;
                padding: 0 8px;
                border: 1px solid rgba(72, 255, 132, 0.86);
                border-radius: 999px;
                background: rgba(5, 30, 14, 0.98);
                color: #dfffe8;
                font: 900 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-style: normal;
                letter-spacing: 0;
                white-space: nowrap;
                box-shadow: 0 0 0 1px rgba(72, 255, 132, 0.12) inset;
            }
            .evm-toolbox-resize-pill-icon::before {
                content: "Resize";
            }
            button:has(.evm-toolbox-resize-pill-icon) {
                overflow: visible;
                position: relative;
            }
            button:has(.evm-toolbox-resize-pill-icon):hover .evm-toolbox-resize-pill-icon {
                border-color: rgba(126, 255, 166, 0.96);
                background: rgba(22, 90, 44, 0.98);
                color: #ffffff;
            }
            button:has(.evm-toolbox-resize-pill-icon):hover::after {
                content: "Equalize width or height";
                position: absolute;
                left: 50%;
                bottom: calc(100% + 9px);
                z-index: 10050;
                transform: translateX(-50%);
                padding: 5px 8px;
                border: 1px solid rgba(126, 255, 166, 0.74);
                border-radius: 8px;
                background: rgba(3, 10, 7, 0.98);
                color: #dfffe8;
                font: 800 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                white-space: nowrap;
                pointer-events: none;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.42);
            }

            .evm-resize-popover-menu {
                position: fixed;
                z-index: 100002;
                display: none;
                width: 228px;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                padding: 8px;
                border: 1px solid rgba(82, 255, 145, 0.82);
                border-radius: 10px;
                background: rgba(4, 13, 8, 0.98);
                box-shadow: 0 16px 36px rgba(0, 0, 0, 0.46), 0 0 0 1px rgba(82, 255, 145, 0.10) inset;
                box-sizing: border-box;
                user-select: none;
            }
            .evm-resize-popover-item {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 7px;
                min-height: 32px;
                padding: 0 9px;
                border: 1px solid rgba(90, 130, 104, 0.72);
                border-radius: 8px;
                background: rgba(9, 13, 11, 0.92);
                color: #dfffe8;
                cursor: pointer;
                font: 700 11.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                text-align: left;
                white-space: nowrap;
                transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
            }
            .evm-resize-popover-item:hover {
                background: rgba(27, 118, 62, 0.98);
                border-color: rgba(110, 255, 165, 0.96);
                color: #ffffff;
            }
            .evm-resize-popover-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                color: #74ff9f;
                flex-shrink: 0;
            }
            .evm-resize-popover-item:hover .evm-resize-popover-icon {
                color: #ffffff;
            }

            .evm-toolbox-clear-color-pill-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 22px;
                height: 22px;
                box-sizing: border-box;
                border: 1.5px solid rgba(255, 255, 255, 0.38);
                border-radius: 999px;
                background: rgba(24, 24, 27, 0.96);
                color: #f87171;
                font: 900 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-style: normal;
                white-space: nowrap;
                transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
            }
            .evm-toolbox-clear-color-pill-icon::before {
                content: "✕";
            }
            button:has(.evm-toolbox-clear-color-pill-icon) {
                overflow: visible;
                position: relative;
            }
            button:has(.evm-toolbox-clear-color-pill-icon):hover .evm-toolbox-clear-color-pill-icon {
                border-color: rgba(248, 113, 113, 0.95);
                background: rgba(69, 10, 10, 0.96);
                color: #fca5a5;
                transform: scale(1.08);
            }
            button:has(.evm-toolbox-clear-color-pill-icon):hover::after {
                content: "Limpar cores";
                position: absolute;
                left: 50%;
                bottom: calc(100% + 9px);
                z-index: 10050;
                transform: translateX(-50%);
                padding: 5px 8px;
                border: 1px solid rgba(248, 113, 113, 0.74);
                border-radius: 8px;
                background: rgba(15, 5, 5, 0.98);
                color: #fecaca;
                font: 800 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                white-space: nowrap;
                pointer-events: none;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.42);
            }

            .evm-toolbox-group-pill-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 22px;
                box-sizing: border-box;
                padding: 0 9px;
                border-radius: 999px;
                font: 800 11.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-style: normal;
                letter-spacing: 0.2px;
                white-space: nowrap;
                border: 1px solid rgba(56, 189, 248, 0.88);
                background: rgba(8, 35, 56, 0.96);
                color: #e0f2fe;
            }
            .evm-toolbox-group-pill-icon::before {
                content: "EVM Group";
            }
            button:has(.evm-toolbox-group-pill-icon) {
                overflow: visible;
            }
            button:has(.evm-toolbox-group-pill-icon):hover .evm-toolbox-group-pill-icon {
                background: rgba(14, 78, 120, 0.98);
                color: #ffffff;
            }

            #evm-group-floating-bar {
                position: fixed;
                top: 0;
                left: 0;
                z-index: 99999;
                display: flex;
                align-items: center;
                gap: 5px;
                padding: 4px 8px;
                background: rgba(24, 24, 27, 0.96);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                user-select: none;
                pointer-events: auto;
            }
            #evm-group-floating-bar .evm-color-picker-wrap {
                position: relative;
                display: inline-flex;
                align-items: center;
            }
            #evm-group-floating-bar .evm-tb-icon-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 3px;
                height: 28px;
                padding: 0 6px;
                background: transparent;
                border: none;
                border-radius: 6px;
                color: #a1a1aa;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease;
            }
            #evm-group-floating-bar .evm-tb-icon-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #ffffff;
            }
            #evm-group-floating-bar .evm-color-dot {
                width: 14px;
                height: 14px;
                border-radius: 999px;
                background: #3f789e;
                border: 1px solid rgba(255, 255, 255, 0.35);
                box-sizing: border-box;
            }
            #evm-group-floating-bar .evm-clear-color-dot {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                border-radius: 999px;
                border: 1.5px solid rgba(255, 255, 255, 0.38);
                background: rgba(24, 24, 27, 0.96);
                color: #f87171;
                font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                box-sizing: border-box;
                transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
            }
            #evm-group-floating-bar .evm-btn-clear-color:hover .evm-clear-color-dot {
                border-color: rgba(248, 113, 113, 0.95);
                background: rgba(69, 10, 10, 0.96);
                color: #fca5a5;
                transform: scale(1.1);
            }
            #evm-group-floating-bar .evm-comfy-color-strip {
                position: absolute;
                bottom: calc(100% + 8px);
                left: 50%;
                transform: translateX(-50%);
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 5px 8px;
                background: rgba(24, 24, 27, 0.98);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
                white-space: nowrap;
            }
            #evm-group-floating-bar .evm-comfy-color-swatch {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                padding: 0;
                background: transparent;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                transition: transform 0.12s ease, background 0.12s ease;
            }
            #evm-group-floating-bar .evm-comfy-color-swatch:hover {
                background: rgba(255, 255, 255, 0.12);
                transform: scale(1.15);
            }
            #evm-group-floating-bar .evm-swatch-circle {
                display: block;
                width: 15px;
                height: 15px;
                border-radius: 999px;
                border: 1px solid rgba(255, 255, 255, 0.32);
                box-sizing: border-box;
            }
            #evm-group-floating-bar .evm-tb-divider {
                width: 1px;
                height: 18px;
                background: rgba(255, 255, 255, 0.14);
                margin: 0 2px;
            }
            #evm-group-floating-bar .evm-tb-pill {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 22px;
                padding: 0 9px;
                border-radius: 999px;
                font: 800 11.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            #evm-group-floating-bar .evm-pill-evmgroup {
                border: 1px solid rgba(56, 189, 248, 0.88);
                background: rgba(8, 35, 56, 0.96);
                color: #e0f2fe;
            }
            #evm-group-floating-bar .evm-pill-evmgroup:hover {
                background: rgba(14, 78, 120, 0.98);
                color: #ffffff;
            }
            #evm-group-floating-bar .evm-pill-fold,
            #evm-group-floating-bar .evm-pill-resize {
                border: 1px solid rgba(72, 255, 132, 0.86);
                background: rgba(5, 30, 14, 0.98);
                color: #dfffe8;
            }
            #evm-group-floating-bar .evm-pill-fold:hover,
            #evm-group-floating-bar .evm-pill-resize:hover {
                background: rgba(22, 90, 44, 0.98);
                color: #ffffff;
            }
            #evm-group-floating-bar .evm-pill-shot {
                border: 1px solid rgba(16, 185, 129, 0.85);
                background: rgba(6, 38, 28, 0.96);
                color: #d1fae5;
            }
            #evm-group-floating-bar .evm-pill-shot:hover {
                background: rgba(12, 85, 60, 0.98);
                color: #ffffff;
            }
            #evm-group-floating-bar .evm-pill-copy {
                border: 1px solid rgba(168, 85, 247, 0.85);
                background: rgba(38, 14, 58, 0.96);
                color: #f3e8ff;
            }
            #evm-group-floating-bar .evm-pill-copy:hover {
                background: rgba(78, 28, 120, 0.98);
                color: #ffffff;
            }
        `;
        document.head.appendChild(style);
    }

    const floatingBar = document.createElement("div");
    floatingBar.id = "evm-group-floating-bar";
    floatingBar.style.display = "none";
    floatingBar.innerHTML = `
        <div class="evm-color-picker-wrap">
            <button class="evm-tb-icon-btn evm-btn-colors" data-testid="color-picker-button" title="Cor do Grupo (Padrão ComfyUI)">
                <span class="evm-color-dot"></span>
                <svg class="evm-color-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="evm-comfy-color-strip" style="display:none;"></div>
        </div>
        <button class="evm-tb-icon-btn evm-btn-clear-color" title="Limpar Cores (Grupo e Nós Internos)">
            <span class="evm-clear-color-dot">✕</span>
        </button>
        <button class="evm-tb-icon-btn evm-btn-delete" title="Excluir Grupo (mantém nós)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
        <span class="evm-tb-divider"></span>
        <button class="evm-tb-pill evm-pill-shot evm-btn-save" style="display:none;" title="Salvar Screenshot PNG">
            <span>PNG</span>
        </button>
        <button class="evm-tb-pill evm-pill-copy evm-btn-copy" style="display:none;" title="Copiar Screenshot para o Clipboard">
            <span>Copy</span>
        </button>
        <button class="evm-tb-pill evm-pill-fold evm-btn-fold" title="Recolher / Expandir EVM Group">
            <span>Fold</span>
        </button>
        <button class="evm-tb-pill evm-pill-resize evm-btn-resize" style="display:none;" title="Igualar Tamanho (Horizontal / Vertical)">
            <span>Resize</span>
        </button>
        <button class="evm-tb-pill evm-pill-evmgroup evm-btn-convert" title="Converter para EVM Group (Set/Get)">
            <span>EVM Group</span>
        </button>
    `;
    document.body.appendChild(floatingBar);

    let currentTarget = null;
    let lastTargetKey = "";
    let colorStripOpen = false;
    const colorStripEl = floatingBar.querySelector(".evm-comfy-color-strip");
    const colorCircleEl = floatingBar.querySelector(".evm-color-dot");

    function closeColorStrip() {
        colorStripOpen = false;
        if (colorStripEl) colorStripEl.style.display = "none";
    }

    function renderColorStrip() {
        if (!colorStripEl) return;
        colorStripEl.innerHTML = "";
        const allOptions = [
            { name: "noColor", label: "Default", groupcolor: DEFAULT_GROUP_COLOR },
            ...getComfyStandardGroupColors(),
        ];
        for (const opt of allOptions) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "evm-comfy-color-swatch";
            btn.title = opt.label;
            btn.setAttribute("data-testid", opt.name);
            btn.innerHTML = `<i class="evm-swatch-circle" style="background:${opt.groupcolor};"></i>`;
            btn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                if (!currentTarget) return;
                if (currentTarget.type === "evmgroup") {
                    setEvmGroupColor(currentTarget.target, opt.groupcolor);
                    if (colorCircleEl) colorCircleEl.style.background = opt.groupcolor;
                } else if (currentTarget.type === "pixgroup") {
                    currentTarget.target.color = opt.groupcolor;
                    currentTarget.target.titleColor = opt.groupcolor;
                    currentTarget.target.bodyColor = opt.groupcolor;
                    window.PixaromaPixGroup?.repaint?.();
                    if (colorCircleEl) colorCircleEl.style.background = opt.groupcolor;
                }
                closeColorStrip();
            });
            colorStripEl.appendChild(btn);
        }
    }

    function isNativeSelectionToolboxVisible() {
        const el = document.querySelector(".selection-toolbox, [data-testid='selection-toolbox'], .p-toolbar.selection-toolbox, button:has(.evm-toolbox-group-pill-icon), button:has(.deno-visual-fold-command-icon)");
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function resolveActiveGroupTarget() {
        if (!app.canvas) return null;
        const selNodes = app.canvas.selected_nodes ? Object.values(app.canvas.selected_nodes).filter(Boolean) : [];
        const evmGroups = getSelectedEvmGroups();
        const evmGroup = getSelectedEvmGroup() || evmGroups[0] || null;
        if (evmGroup) {
            const list = evmGroups.length ? evmGroups : [evmGroup];
            return {
                type: "evmgroup",
                key: `evm:${list.map(g => g.id).join(",")}:n:${selNodes.map(n => n.id).join(",")}`,
                target: evmGroup,
                targets: list,
                hasCoSelectedNodes: selNodes.length > 0,
                title: list.length === 1 ? (evmGroup.title || "EVM Group") : `${list.length} EVM Groups`,
                getBounds: () => {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    for (const g of list) {
                        minX = Math.min(minX, g.x);
                        minY = Math.min(minY, g.y);
                        maxX = Math.max(maxX, g.x + g.w);
                        maxY = Math.max(maxY, g.y + g.h);
                    }
                    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
                },
            };
        }

        let pixGroup = null;
        if (window.PixaromaPixGroup) {
            try {
                pixGroup = window.PixaromaPixGroup.getSelected?.() ||
                           (window.PixaromaPixGroup.getSelectedGroups?.() || [])[0] ||
                           null;
            } catch (_e) {}
        }
        if (!pixGroup) {
            const gs = curGraph()?.extra?.pixaromaGroups;
            if (Array.isArray(gs)) pixGroup = gs.find(g => g && (g.selected || g._selected));
        }
        if (pixGroup) {
            return {
                type: "pixgroup",
                key: `pix:${pixGroup.id}`,
                target: pixGroup,
                title: pixGroup.title || "Pixaroma Group",
                getBounds: () => ({ x: pixGroup.x, y: pixGroup.y, w: pixGroup.w, h: pixGroup.h }),
            };
        }
        return null;
    }

    function updateGroupFloatingBar() {
        if (!EVM_CFG.showFloatingToolbar || !app.canvas || !app.canvas.canvas) {
            floatingBar.style.display = "none";
            closeColorStrip();
            return;
        }
        const target = resolveActiveGroupTarget();
        currentTarget = target;
        if (!target) {
            floatingBar.style.display = "none";
            closeColorStrip();
            lastTargetKey = "";
            return;
        }
        if (target.key !== lastTargetKey) {
            lastTargetKey = target.key;
            closeColorStrip();
        }
        if (target.type === "evmgroup" && target.hasCoSelectedNodes && isNativeSelectionToolboxVisible()) {
            floatingBar.style.display = "none";
            closeColorStrip();
            return;
        }

        const bounds = target.getBounds();
        if (!bounds) {
            floatingBar.style.display = "none";
            closeColorStrip();
            return;
        }

        const hasScreenshotSupport = typeof window._evmCaptureTarget === "function";
        const btnSave = floatingBar.querySelector(".evm-btn-save");
        const btnCopy = floatingBar.querySelector(".evm-btn-copy");
        const btnConvert = floatingBar.querySelector(".evm-btn-convert");
        const btnColors = floatingBar.querySelector(".evm-btn-colors");
        const btnFold = floatingBar.querySelector(".evm-btn-fold");
        const btnResize = floatingBar.querySelector(".evm-btn-resize");
        const btnDelete = floatingBar.querySelector(".evm-btn-delete");

        if (btnSave) btnSave.style.display = hasScreenshotSupport ? "inline-flex" : "none";
        if (btnCopy) btnCopy.style.display = hasScreenshotSupport ? "inline-flex" : "none";
        if (btnDelete) btnDelete.style.display = target.type === "evmgroup" ? "inline-flex" : "none";
        if (btnConvert) btnConvert.style.display = target.type === "pixgroup" ? "inline-flex" : "none";

        if (btnColors) {
            btnColors.style.display = "inline-flex";
            const curCol = target.type === "evmgroup"
                ? gGroupColor(target.target)
                : (target.target.color || target.target.titleColor || DEFAULT_GROUP_COLOR);
            if (colorCircleEl) colorCircleEl.style.background = curCol;
        }

        if (btnFold) {
            if (target.type === "evmgroup") {
                btnFold.style.display = "inline-flex";
                btnFold.querySelector("span").textContent = target.target.folded ? "Unfold" : "Fold";
            } else {
                btnFold.style.display = "none";
            }
        }

        if (btnResize) {
            const canResizeGroups = target.type === "evmgroup" && Array.isArray(target.targets) && target.targets.length >= 2;
            const canResizeNodes = getResizeableSelectedNodes().length >= 2;
            btnResize.style.display = (canResizeGroups || canResizeNodes) ? "inline-flex" : "none";
        }

        floatingBar.style.display = "flex";

        const canvasRect = app.canvas.canvas.getBoundingClientRect();
        const ds = app.canvas.ds;
        const screenCenterX = canvasRect.left + (bounds.x + bounds.w / 2 + ds.offset[0]) * ds.scale;
        const screenTop = canvasRect.top + (bounds.y + ds.offset[1]) * ds.scale;

        const barW = floatingBar.offsetWidth || 220;
        const barH = floatingBar.offsetHeight || 36;
        let posX = screenCenterX - barW / 2;
        let posY = screenTop - barH - 10;
        if (posY < 50) posY = screenTop + 8;
        posX = Math.max(10, Math.min(window.innerWidth - barW - 10, posX));

        floatingBar.style.transform = `translate(${Math.round(posX)}px, ${Math.round(posY)}px)`;
    }

    floatingBar.querySelector(".evm-btn-save")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentTarget && typeof window._evmCaptureTarget === "function") {
            window._evmCaptureTarget(currentTarget, "save");
        }
    });

    floatingBar.querySelector(".evm-btn-copy")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentTarget && typeof window._evmCaptureTarget === "function") {
            window._evmCaptureTarget(currentTarget, "copy");
        }
    });

    floatingBar.querySelector(".evm-btn-convert")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentTarget?.type === "pixgroup") {
            convertPixaromaGroupToEvm(currentTarget.target);
            setTimeout(updateGroupFloatingBar, 30);
        }
    });

    floatingBar.querySelector(".evm-btn-colors")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!currentTarget) return;
        colorStripOpen = !colorStripOpen;
        if (colorStripOpen) {
            renderColorStrip();
            if (colorStripEl) colorStripEl.style.display = "flex";
        } else {
            closeColorStrip();
        }
    });

    floatingBar.querySelector(".evm-btn-clear-color")?.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSelectionColors();
        if (colorCircleEl) colorCircleEl.style.background = DEFAULT_GROUP_COLOR;
        closeColorStrip();
    });

    floatingBar.querySelector(".evm-btn-fold")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentTarget?.type === "evmgroup") {
            const list = currentTarget.targets?.length ? currentTarget.targets : [currentTarget.target];
            for (const g of list) toggleFoldEvmGroup(g);
            setTimeout(updateGroupFloatingBar, 30);
        }
    });

    floatingBar.querySelector(".evm-btn-resize")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleEvmResizePopover(e.currentTarget);
    });

    floatingBar.querySelector(".evm-btn-delete")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentTarget?.type === "evmgroup") {
            const list = currentTarget.targets?.length ? [...currentTarget.targets] : [currentTarget.target];
            for (const g of list) deleteEvmGroup(g);
            setTimeout(updateGroupFloatingBar, 30);
        }
    });

    // ── Integração com Color Picker Nativo do ComfyUI e com EasyKit NodeAlignPro (#hNodeAlignKit) ──
    const NODE_ALIGN_PRO_COLORS = Object.freeze({
        colorRed: "#a93232",
        colorOrange: "#79461d",
        colorYellow: "#6e6e1d",
        colorGreen: "#2b652b",
        colorCyan: "#248382",
        colorBlue: "#246283",
        colorPurple: "#3c3c83",
    });

    function moveEvmGroupWithMembers(g, nextX, nextY) {
        const targetX = snap(nextX);
        const targetY = snap(nextY);
        const dx = targetX - g.x;
        const dy = targetY - g.y;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
        const members = groupMemberNodes(g);
        const subGroups = containedEvmGroups(g);
        g.x = targetX;
        g.y = targetY;
        for (const sg of subGroups) {
            sg.x = snap(sg.x + dx);
            sg.y = snap(sg.y + dy);
        }
        for (const n of members) {
            if (n && n.pos) setNodePos(n, n.pos[0] + dx, n.pos[1] + dy);
        }
    }

    function alignSelectedEvmGroups(btnId, groups) {
        if (!groups || groups.length < 2) return;
        const list = [...groups];
        if (btnId === "hBtnA_alignLeft") {
            const minX = Math.min(...list.map(g => g.x));
            for (const g of list) moveEvmGroupWithMembers(g, minX, g.y);
        } else if (btnId === "hBtnC_alignRight") {
            const maxR = Math.max(...list.map(g => g.x + g.w));
            for (const g of list) moveEvmGroupWithMembers(g, maxR - g.w, g.y);
        } else if (btnId === "hBtnB_alignCenterV") {
            const minX = Math.min(...list.map(g => g.x));
            const maxR = Math.max(...list.map(g => g.x + g.w));
            const cx = (minX + maxR) / 2;
            for (const g of list) moveEvmGroupWithMembers(g, cx - g.w / 2, g.y);
        } else if (btnId === "hBtnD_alignTop") {
            const minY = Math.min(...list.map(g => g.y));
            for (const g of list) moveEvmGroupWithMembers(g, g.x, minY);
        } else if (btnId === "hBtnF_alignButton") {
            const maxB = Math.max(...list.map(g => g.y + g.h));
            for (const g of list) moveEvmGroupWithMembers(g, g.x, maxB - g.h);
        } else if (btnId === "hBtnE_alignCenterH") {
            const minY = Math.min(...list.map(g => g.y));
            const maxB = Math.max(...list.map(g => g.y + g.h));
            const cy = (minY + maxB) / 2;
            for (const g of list) moveEvmGroupWithMembers(g, g.x, cy - g.h / 2);
        } else if (btnId === "hBtnG_distributionH") {
            list.sort((a, b) => a.x - b.x);
            const minX = Math.min(...list.map(g => g.x));
            const maxR = Math.max(...list.map(g => g.x + g.w));
            const totalW = list.reduce((s, g) => s + g.w, 0);
            const gap = (maxR - minX - totalW) / (list.length - 1);
            let curX = minX;
            for (const g of list) {
                moveEvmGroupWithMembers(g, curX, g.y);
                curX += g.w + gap;
            }
        } else if (btnId === "hBtnH_distributionV") {
            list.sort((a, b) => a.y - b.y);
            const minY = Math.min(...list.map(g => g.y));
            const maxB = Math.max(...list.map(g => g.y + g.h));
            const totalH = list.reduce((s, g) => s + g.h, 0);
            const gap = Math.max(PAD, (maxB - minY - totalH) / (list.length - 1));
            let curY = minY;
            for (const g of list) {
                moveEvmGroupWithMembers(g, g.x, curY);
                curY += g.h + gap;
            }
        } else if (btnId === "hBtnI_equalWidth") {
            const maxW = snapUp(Math.max(...list.map(g => g.w)));
            for (const g of list) {
                if (!g.folded) {
                    g.w = Math.max(minGroupWidth(g), maxW);
                    layoutDockedNodes(g);
                }
            }
        } else if (btnId === "hBtnJ_equalHeight") {
            const maxH = snapUp(Math.max(...list.map(g => g.h)));
            for (const g of list) {
                if (!g.folded) {
                    g.h = Math.max(MIN_GROUP_H, maxH);
                    layoutDockedNodes(g);
                }
            }
        }
        markChanged();
    }

    window.addEventListener("click", (e) => {
        const alignBtn = e.target?.closest?.("#hNodeAlignKit button");
        if (alignBtn) {
            const btnId = alignBtn.id || "";
            if (btnId === "hBtnI_equalWidth" || btnId === "hBtnJ_equalHeight") {
                if (canResizeCurrentSelection()) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    runEvmEqualizeSize(btnId === "hBtnI_equalWidth" ? "width" : "height");
                    return;
                }
            }
        }

        const evmGroups = getSelectedEvmGroups();
        if (!evmGroups.length) return;

        // 1. Integração direta com a barra EasyKit NodeAlignPro (#hNodeAlignKit)
        if (alignBtn) {
            const btnId = alignBtn.id || "";
            const hasNativeSelected = !!(
                (app.canvas?.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) ||
                app.canvas?.selected_group ||
                (app.graph?.groups && app.graph.groups.some(g => g.selected))
            );
            // Botões de cor do NodeAlignPro (#colorRed .. #colorPurple) -> no EVM Group aplica sempre no título e no corpo
            if (btnId in NODE_ALIGN_PRO_COLORS) {
                const hex = NODE_ALIGN_PRO_COLORS[btnId];
                setEvmGroupColor(evmGroups[0], hex);
                if (colorCircleEl) colorCircleEl.style.background = hex;
                if (!hasNativeSelected) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                }
                return;
            }

            // Botão Limpar/Resetar cor (#colorClear)
            if (btnId === "colorClear") {
                setEvmGroupColor(evmGroups[0], null);
                if (colorCircleEl) colorCircleEl.style.background = DEFAULT_GROUP_COLOR;
                if (!hasNativeSelected) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                }
                return;
            }

            // Botão Seletor de Cor Customizado (#colorPick)
            if (btnId === "colorPick" && !hasNativeSelected) {
                e.stopImmediatePropagation();
                e.preventDefault();
                const input = document.createElement("input");
                input.type = "color";
                input.style.cssText = "position:fixed;opacity:0;pointer-events:none;top:-100px;";
                input.value = gGroupColor(evmGroups[0]);
                const applyPicked = (ev) => {
                    const picked = ev.target?.value;
                    if (picked) {
                        setEvmGroupColor(evmGroups[0], picked);
                        if (colorCircleEl) colorCircleEl.style.background = normalizeHex(picked);
                    }
                };
                input.addEventListener("input", applyPicked);
                input.addEventListener("change", (ev) => {
                    applyPicked(ev);
                    input.remove();
                });
                document.body.appendChild(input);
                input.click();
                return;
            }

            // Botões de Alinhamento / Distribuição / Tamanho Igual do NodeAlignPro (#hBtnA..#hBtnJ)
            if (btnId.startsWith("hBtn") && btnId !== "hBtn_moveElement" && !hasNativeSelected) {
                e.stopImmediatePropagation();
                e.preventDefault();
                alignSelectedEvmGroups(btnId, evmGroups);
                return;
            }
        }

        // 2. Integração com o Color Picker nativo da Selection Toolbox do ComfyUI
        const btn = e.target?.closest?.("button[data-testid], .color-picker-container button");
        if (!btn || floatingBar.contains(btn)) return;
        const testId = btn.getAttribute("data-testid") || "";
        const stdColors = getComfyStandardGroupColors();
        if (testId === "noColor") {
            setEvmGroupColor(evmGroups[0], null);
        } else {
            const match = stdColors.find(c => c.name === testId);
            if (match) setEvmGroupColor(evmGroups[0], match.groupcolor);
        }
    }, true);

    // Sincroniza também quando o #colorPick do NodeAlignPro abre um <input type="color"> com nós + EVM Group co-selecionados
    document.addEventListener("change", (e) => {
        if (e.target && e.target.tagName === "INPUT" && e.target.type === "color") {
            const evmGroups = getSelectedEvmGroups();
            if (evmGroups.length && e.target.value) {
                setEvmGroupColor(evmGroups[0], e.target.value);
                if (colorCircleEl) colorCircleEl.style.background = normalizeHex(e.target.value);
            }
        }
    }, true);

    const wrapFg = () => {
        if (!app.canvas) {
            setTimeout(wrapFg, 200);
            return;
        }
        if (app.canvas._evmGroupFgBarWrapped) return;
        const origFg = app.canvas.onDrawForeground;
        app.canvas.onDrawForeground = function () {
            origFg?.apply(this, arguments);
            updateGroupFloatingBar();
        };
        app.canvas._evmGroupFgBarWrapped = true;
    };
    wrapFg();

    window.addEventListener("pointerdown", (e) => {
        if (colorStripOpen && !floatingBar.contains(e.target)) closeColorStrip();
        setTimeout(updateGroupFloatingBar, 20);
    }, true);
    window.addEventListener("pointerup", () => setTimeout(updateGroupFloatingBar, 20), true);
    window.addEventListener("resize", updateGroupFloatingBar);
}

// ── Registro da Extensão, Settings e Menu de Contexto ────────────────────────
app.registerExtension({
    name: "EVM.AdvancedGroup",
    settings: EVM_SETTINGS_DEFS,
    commands: [
        {
            id: EVM_CLEAR_COLOR_TOOLBOX_CMD,
            label: "Clear colors of selected nodes and groups",
            tooltip: "Limpar cores dos nós/grupos selecionados",
            icon: "evm-toolbox-clear-color-pill-icon",
            function: () => clearSelectionColors(),
        },
        {
            id: EVM_RESIZE_TOOLBOX_CMD,
            label: "Resize selection (Equal Width / Equal Height)",
            tooltip: "Equalize width or height",
            icon: "evm-toolbox-resize-pill-icon",
            function: () => toggleEvmResizePopover(),
        },
        {
            id: EVM_GROUP_TOOLBOX_CMD,
            label: "Create or convert to EVM Advanced Group (Set/Get)",
            tooltip: "Criar / Converter para EVM Advanced Group (GetNode / SetNode)",
            icon: "evm-toolbox-group-pill-icon",
            function: () => triggerCreateOrConvertFromSelection(),
        },
    ],

    getSelectionToolboxCommands(_selectedItem) {
        if (!EVM_CFG.showConvertInNativeToolbox || !app.canvas) return [];
        const hasNodes = app.canvas.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0;
        const hasNativeGroup = !!(
            app.canvas.selected_group ||
            (app.canvas.selectedItems && [...app.canvas.selectedItems].some(it => it && (it._nodes || it.isGroup || (it.pos && it.size && !it.widgets && !it.inputs && !it.outputs && !it.id))))
        );
        if (hasNodes || hasNativeGroup) {
            const cmds = [EVM_CLEAR_COLOR_TOOLBOX_CMD];
            if (canResizeCurrentSelection()) {
                cmds.push(EVM_RESIZE_TOOLBOX_CMD);
            }
            cmds.push(EVM_GROUP_TOOLBOX_CMD);
            return cmds;
        }
        return [];
    },

    getCanvasMenuItems(canvas) {
        const gm = canvas?.graph_mouse || app.canvas?.graph_mouse;
        const p = gm ? [gm[0], gm[1]] : null;
        const overEvm = p ? evmGroupAt(p) : null;
        const overPix = (!overEvm && p && window.PixaromaPixGroup?.groupAt) ? window.PixaromaPixGroup.groupAt(p) : null;

        const organizeSubmenu = [
            {
                content: "⚡ Organizar Completo (Auto + Set/Get)",
                callback: () => organizeCurrentWorkflow({ mode: "auto", wire_set_get: true, paint: true }),
            },
            {
                content: "📐 Organizar Grupos Existentes (Manter Soltos)",
                callback: () => organizeCurrentWorkflow({ mode: "existing", wire_set_get: true, paint: true }),
            },
            {
                content: "🧲 Organizar + Adotar Nós Soltos (--adopt)",
                callback: () => organizeCurrentWorkflow({ mode: "adopt", wire_set_get: true, paint: true }),
            },
            {
                content: "🔄 Reagrupar Tudo do Zero (--regroup)",
                callback: () => organizeCurrentWorkflow({ mode: "regroup", wire_set_get: true, paint: true }),
            },
            {
                content: "🔗 Organizar Sem Criar Set/Get (--no-wire-set-get)",
                callback: () => organizeCurrentWorkflow({ mode: "auto", wire_set_get: false, paint: true }),
            },
            {
                content: "🎨 Organizar Sem Alterar Cores (--no-paint)",
                callback: () => organizeCurrentWorkflow({ mode: "auto", wire_set_get: true, paint: false }),
            },
        ];

        if (_organizeUndoStack.length > 0) {
            organizeSubmenu.push(
                null,
                {
                    content: "↩️ Desfazer Última Organização",
                    callback: () => undoLastWorkflowOrganize(),
                }
            );
        }

        const items = [
            null,
            { content: "⚡ Add EVM Group (Set/Get)", callback: () => createEvmGroup(p) },
            {
                content: "🪄 Organizar Workflow (Padrão Dj Edu)",
                has_submenu: true,
                submenu: {
                    title: "Organizar Workflow",
                    options: organizeSubmenu,
                },
            },
        ];

        if (_organizeUndoStack.length > 0) {
            items.push({
                content: "↩️ Desfazer Última Organização",
                callback: () => undoLastWorkflowOrganize(),
            });
        }

        if (overPix) {
            items.push({
                content: "⚡ Converter Pixaroma Group → EVM Group",
                callback: () => convertPixaromaGroupToEvm(overPix),
            });
        }

        if (overEvm) {
            const colorOptions = [
                {
                    content: "Default (Pale Blue)",
                    callback: () => setEvmGroupColor(overEvm, DEFAULT_GROUP_COLOR),
                },
                ...getComfyStandardGroupColors().map(c => ({
                    content: c.label,
                    callback: () => setEvmGroupColor(overEvm, c.groupcolor),
                })),
            ];

            items.push(
                {
                    content: "🎨 EVM Color Palette (\\)",
                    callback: () => {
                        selectEvmGroup(overEvm);
                        if (window.EVMColorPalette?.openForEvmGroup) {
                            window.EVMColorPalette.openForEvmGroup(overEvm);
                        } else if (window.EVMColorPalette?.openForSelection) {
                            window.EVMColorPalette.openForSelection();
                        }
                    },
                },
                {
                    content: "🎨 Color (Padrão ComfyUI)",
                    has_submenu: true,
                    submenu: {
                        title: "Group Color",
                        options: colorOptions,
                    },
                },
                {
                    content: "🧹 Limpar Cores do Grupo e Nós",
                    callback: () => {
                        setEvmGroupColor(overEvm, null);
                        for (const n of groupMemberNodes(overEvm)) {
                            delete n.color;
                            delete n.bgcolor;
                        }
                        markChanged();
                        repaint();
                    },
                },
                {
                    content: `📐 Organizar Nós do Grupo (${Math.round(PAD / GRID)} quadradinhos)`,
                    callback: () => {
                        tidyGroupCentralNodes(overEvm, curGraph());
                        markChanged();
                    },
                },
                { content: "➕ Adicionar GetNode (Esquerda)", callback: () => addDockedGetNode(overEvm) },
                { content: "➕ Adicionar SetNode (Direita)", callback: () => addDockedSetNode(overEvm) },
                {
                    content: overEvm.leftRailOpen !== false ? "◀ Ocultar Painel GetNode" : "▶ Mostrar Painel GetNode",
                    callback: () => toggleLeftRail(overEvm),
                },
                {
                    content: overEvm.rightRailOpen !== false ? "▶ Ocultar Painel SetNode" : "◀ Mostrar Painel SetNode",
                    callback: () => toggleRightRail(overEvm),
                },
                {
                    content: overEvm.folded ? "🔽 Expandir EVM Group (Unfold)" : "🔼 Recolher EVM Group (Fold)",
                    callback: () => toggleFoldEvmGroup(overEvm),
                },
                {
                    content: overEvm.pinned ? "📌 Desafixar EVM Group (Unpin)" : "📌 Fixar EVM Group (Pin)",
                    callback: () => {
                        if (overEvm.pinned) delete overEvm.pinned;
                        else overEvm.pinned = true;
                        markChanged();
                    },
                },
                { content: "🗑️ Excluir EVM Group (mantém os nós)", callback: () => deleteEvmGroup(overEvm) }
            );
        }

        return items;
    },

    beforeConfigureGraph() {
        _evmConfiguring = true;
        installPersistence();
    },

    afterConfigureGraph() {
        _evmConfiguring = false;
        const gr = curGraph();
        if (gr) {
            gr._evmConfiguring = false;
            const groups = ensureEvmGroups(gr);
            for (const n of (gr._nodes || [])) {
                if (n) delete n._evmLastGroupId;
            }
            for (const g of groups) {
                migrateLegacyColorsIfNeeded(g);
                ensureDockArrays(g);
                const cNodes = getCentralMemberNodes(g, gr);
                syncGroupLayoutSignature(g, gr, cNodes);
            }
            invalidateHidden();
            updateHideCSS();
        }
    },

    setup() {
        installDrawHook();
        installPersistence();
        installFoldAndRailHideHooks();
        installNodeCollapseAndResizeHooks();
        installSetNodeConnectionHook();
        installExecListeners();
        initEvmGroupFloatingBar();

        setInterval(() => {
            try {
                installDrawHook();
                installPersistence();
                installNodeCollapseAndResizeHooks();
                installSetNodeConnectionHook();
                updateHideCSS();
            } catch (_e) {}
        }, 800);

        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("pointermove", onHoverMove, false);
        window.addEventListener("pointerup", onGlobalPointerUp, true);
        window.addEventListener("pointercancel", onGlobalPointerUp, true);
        window.addEventListener("dblclick", onDblClick, true);
        window.addEventListener("keydown", e => {
            const t = e.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "a") {
                const all = ensureEvmGroups().filter(g => !isHiddenGroup(g));
                if (all.length) {
                    _selectedIds = new Set(all.map(g => g.id));
                    _selectedId = all[all.length - 1].id;
                    repaint();
                }
                return;
            }
            if (e.key === "Delete" || e.key === "Backspace") {
                const sel = getSelectedEvmGroups();
                if (!sel.length) return;
                const nativeNodes = app.canvas?.selected_nodes ? Object.keys(app.canvas.selected_nodes).length : 0;
                e.preventDefault();
                if (!nativeNodes) e.stopImmediatePropagation();
                for (const g of sel) deleteEvmGroup(g);
            }
        }, true);
        window.addEventListener("blur", () => {
            if (_drag) { _drag = null; stopWinDrag(); }
            _carry = null;
            _lmbDown = false;
            _clickDeselectPending = false;
            _pendingEvmSelect = null;
            _pendingBodyAdditiveToggle = null;
            _marqueeRect = null;
            _marqueeStartPt = null;
            _marqueeShift = false;
            _preMarqueeSelectedIds = null;
        });

        // Expõe API global para integração com evm_node_screenshot.js, evm_color_palette.js e Selection Toolbox
        window.EVMGroupSetGet = {
            hasOwnFloatingBar: true,
            createGroup: createEvmGroup,
            deleteGroup: deleteEvmGroup,
            convertPixaromaGroup: convertPixaromaGroupToEvm,
            convertNativeGroup: convertNativeGroupToEvm,
            setGroupColor: setEvmGroupColor,
            getGroupColor: gGroupColor,
            getTitleColor: gTitleColor,
            getBodyColor: gBodyColor,
            getTitleAlpha: gTitleAlpha,
            getBodyAlpha: gBodyAlpha,
            getFontSize: gFontSize,
            groupScreenRect,
            markChanged,
            getStandardColors: getComfyStandardGroupColors,
            tidyGroup: (g) => tidyGroupCentralNodes(g || getSelectedEvmGroup(), curGraph()),
            toggleLeftRail,
            toggleRightRail,
            toggleFold: toggleFoldEvmGroup,
            addGetNode: addDockedGetNode,
            addSetNode: addDockedSetNode,
            getSelected: getSelectedEvmGroup,
            getSelectedGroups: getSelectedEvmGroups,
            getAllGroups: ensureEvmGroups,
            getMemberNodes: groupMemberNodes,
            groupAt: evmGroupAt,
            organizeWorkflow: organizeCurrentWorkflow,
            undoOrganizeWorkflow: undoLastWorkflowOrganize,
            resizeSelection: runEvmEqualizeSize,
            clearColors: clearSelectionColors,
            repaint,
        };
        window.EVMAdvancedGroup = window.EVMGroupSetGet;

        console.log("[ComfyUI-EVM-Advanced-Group] Inicializado com sucesso (Settings nativos ⚡ EVM Advanced Group + Grid 3 quadradinhos + Auto-Reflow).");
    },
});
