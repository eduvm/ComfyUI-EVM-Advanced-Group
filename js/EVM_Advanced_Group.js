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
    ctx.font = node?.innerFontStyle || node?.titleFontStyle || "bold 14px Arial, sans-serif";
    const fullTitle = String((typeof node?.getTitle === "function" ? node.getTitle() : node?.title) || node?.type || "");
    // No LiteGraph drawTitleText: quando collapsed, exibe substr(0, 20), mas measure() usa getTitle() completo
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
    const expandedReqW = computeSetGetExpandedRequiredWidth(node);

    // Ajusta automaticamente a largura mínima quando o texto do Set/Get muda,
    // mas permite redimensionamento horizontal manual sem travar o tamanho anterior.
    if (node.size && node._evmLastReqW !== expandedReqW) {
        if (!node.size[0] || node.size[0] < expandedReqW || node.size[0] === node._evmLastReqW) {
            node.size[0] = expandedReqW;
        }
        node._evmLastReqW = expandedReqW;
    }

    if (node.flags?.collapsed) {
        return computeNodeCollapsedWidth(node);
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

/**
 * Retorna apenas os nós centrais (custom nodes normais) contidos dentro do grupo,
 * excluindo os GetNodes e SetNodes ancorados nos trilhos laterais.
 */
function getCentralMemberNodes(g, graph) {
    const gr = graph || curGraph();
    if (!gr || !g || g.folded) return [];
    ensureDockArrays(g);
    const dockedSet = new Set([
        ...g.getNodeIds.map(String),
        ...g.setNodeIds.map(String),
    ]);
    const out = [];
    for (const n of (gr._nodes || [])) {
        if (!n || !n.pos) continue;
        if (dockedSet.has(String(n.id))) continue;
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const centerInGroup = (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h);
        // Mantém o nó no grupo durante redimensionamento horizontal/vertical rápido
        // (onde o canto superior esquerdo permanece ancorado dentro do grupo)
        const topLeftInGroup = (
            n._evmLastGroupId === g.id &&
            b.x >= g.x && b.x <= g.x + g.w &&
            b.y >= g.y && b.y <= g.y + g.h
        );
        if (centerInGroup || topLeftInGroup) {
            n._evmLastGroupId = g.id;
            out.push(n);
        } else if (n._evmLastGroupId === g.id) {
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
    const sortedX = [...nodes].sort((a, b) => (a.pos[0] - b.pos[0]) || (a.pos[1] - b.pos[1]));
    const subCols = [];
    for (const n of sortedX) {
        const nx = n.pos[0];
        let placed = false;
        for (const col of subCols) {
            if (Math.abs(nx - col[0].pos[0]) < COL_THRESHOLD) {
                col.push(n);
                placed = true;
                break;
            }
        }
        if (!placed) subCols.push([n]);
    }
    for (const col of subCols) {
        col.sort((a, b) => (a.pos[1] - b.pos[1]) || (a.id - b.id));
    }
    return subCols;
}

/**
 * Posiciona automaticamente todos os GetNodes no trilho esquerdo e SetNodes no trilho direito,
 * redimensionando automaticamente a largura de cada trilho para o GetNode/SetNode mais largo
 * (respeitando se os nós estão maximizados ou minimizados) e mantendo 3 quadradinhos (30px)
 * de margem e de espaçamento vertical entre os nós (NODE_VGAP = 60px).
 */
function layoutDockedNodes(g, graph, opts = {}) {
    if (!g || g.folded) return;
    const gr = graph || curGraph();
    if (!gr) return;
    ensureDockArrays(g);

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

    // 3. Ajusta leftRailW e rightRailW mantendo a Área Central ancorada no mesmo X do canvas
    const oldLeftOpenW = g.leftRailOpen === false ? 0 : (g.leftRailW || DEFAULT_RAIL_W);
    const oldRightOpenW = g.rightRailOpen === false ? 0 : (g.rightRailW || DEFAULT_RAIL_W);
    const centerX0 = snap(g.x + oldLeftOpenW);
    const currentCenterW = Math.max(MIN_CENTER_W, snap(g.w - oldLeftOpenW - oldRightOpenW));

    g.leftRailW = targetLeftW;
    g.rightRailW = targetRightW;

    const newLeftOpenW = g.leftRailOpen === false ? 0 : g.leftRailW;
    const newRightOpenW = g.rightRailOpen === false ? 0 : g.rightRailW;

    g.x = snap(centerX0 - newLeftOpenW);
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
    const centralNodes = opts.centralNodes || getCentralMemberNodes(g, gr);
    for (const cn of centralNodes) {
        const bodyH = getNodeActiveBodyHeight(cn);
        const nodeBottom = snap(cn.pos[1]) + bodyH;
        if (nodeBottom > maxBottomY) maxBottomY = nodeBottom;
    }

    const requiredH = Math.max(MIN_GROUP_H, snap((maxBottomY + PAD) - g.y));
    if (opts.shrinkHeightToFit || requiredH > g.h) {
        g.h = requiredH;
    }
}

/**
 * Organiza os custom nodes da Área Central do grupo aplicando a geometria canônica
 * da skill `organizar-workflows`:
 * - Margem de 3 quadradinhos (PAD = 30px) à esquerda, à direita, na base e abaixo da barra de título (g.y + 30).
 * - Gap de 3 quadradinhos visíveis (NODE_VGAP = 60px) verticalmente entre os nós da mesma coluna.
 * - Gap de 3 quadradinhos (NODE_HGAP = 30px) horizontalmente entre colunas.
 * - Redimensiona a largura do grupo (g.w) e a altura (g.h) em tempo real ao redimensionar
 *   qualquer nó horizontalmente ou verticalmente.
 */
function tidyGroupCentralNodes(g, graph, explicitCentralNodes = null, opts = {}) {
    if (!g || g.folded) return;
    const gr = graph || curGraph();
    if (!gr) return;
    ensureDockArrays(g);

    const centralNodes = explicitCentralNodes || getCentralMemberNodes(g, gr);
    if (!centralNodes.length) {
        layoutDockedNodes(g, gr, { shrinkHeightToFit: true, isLiveReflow: opts.isLiveReflow });
        return;
    }

    // Primeiro garante que leftRailW e rightRailW já estejam calculados para os Set/Get atuais
    layoutDockedNodes(g, gr, { centralNodes, isLiveReflow: opts.isLiveReflow });

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

    // Reposiciona o trilho direito e ajusta a altura final do grupo com 3 quadradinhos (PAD = 30px) na base
    layoutDockedNodes(g, gr, { centralNodes, shrinkHeightToFit: true, isLiveReflow: opts.isLiveReflow });
}

/**
 * Monitora alterações de estado maximizado/minimizado (collapse) ou tamanho (horizontal e vertical)
 * dos nós dentro de cada EVM Group e faz reflow imediato para que o grupo e os nós acompanhem em tempo real.
 */
function checkAndReflowGroupIfNeeded(g, graph) {
    if (!EVM_CFG.autoReflow || !g || g.folded || _drag || _carry || app.canvas?.dragging_rectangle) return;
    const gr = graph || curGraph();
    if (!gr) return;
    ensureDockArrays(g);

    const getNodes = resolveNodeList(gr, g.getNodeIds);
    const setNodes = resolveNodeList(gr, g.setNodeIds);
    const centralNodes = getCentralMemberNodes(g, gr);

    // Gera assinatura de estado (collapsed, largura, altura e título) dos nós do grupo
    let sig = `${g.leftRailOpen}:${g.rightRailOpen}|`;
    for (const n of getNodes) {
        sig += `G${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    for (const n of setNodes) {
        sig += `S${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }

    let centralCollapseOrSizeChanged = false;
    for (const cn of centralNodes) {
        const cFlag = cn.flags?.collapsed ? 1 : 0;
        const cW = Math.round(cn.size?.[0] || 140);
        const cH = cFlag ? 0 : Math.round(cn.size?.[1] || 30);
        if (
            cn._evmPrevCollapsed !== undefined &&
            (cn._evmPrevCollapsed !== cFlag || cn._evmPrevW !== cW || cn._evmPrevBodyH !== cH)
        ) {
            centralCollapseOrSizeChanged = true;
        }
        cn._evmPrevCollapsed = cFlag;
        cn._evmPrevW = cW;
        cn._evmPrevBodyH = cH;
        sig += `C${cn.id}:${cFlag}:${cW}:${cH};`;
    }

    if (sig === g._lastLayoutSig) return;
    g._lastLayoutSig = sig;

    if (centralCollapseOrSizeChanged || centralNodes.length > 0) {
        tidyGroupCentralNodes(g, gr, centralNodes, { isLiveReflow: true });
    } else {
        layoutDockedNodes(g, gr, { centralNodes, shrinkHeightToFit: true, isLiveReflow: true });
    }

    // Atualiza a assinatura pós-layout para evitar loop
    let postSig = `${g.leftRailOpen}:${g.rightRailOpen}|`;
    for (const n of getNodes) {
        postSig += `G${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    for (const n of setNodes) {
        postSig += `S${n.id}:${n.flags?.collapsed ? 1 : 0}:${Math.round(n.size?.[0] || 0)}:${Math.round(n.size?.[1] || 0)}:${n.title || ""}:${n.widgets?.[0]?.value || ""};`;
    }
    for (const cn of centralNodes) {
        const cFlag = cn.flags?.collapsed ? 1 : 0;
        const cW = Math.round(cn.size?.[0] || 140);
        const cH = cFlag ? 0 : Math.round(cn.size?.[1] || 30);
        cn._evmPrevCollapsed = cFlag;
        cn._evmPrevW = cW;
        cn._evmPrevBodyH = cH;
        postSig += `C${cn.id}:${cFlag}:${cW}:${cH};`;
    }
    g._lastLayoutSig = postSig;
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
    layoutDockedNodes(g, curGraph(), { shrinkHeightToFit: true });
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

    const rw = g.rightRailW || DEFAULT_RAIL_W;
    if (nextOpen) {
        g.rightRailOpen = true;
        g.w = snap(g.w + rw);
    } else {
        g.rightRailOpen = false;
        g.w = Math.max(leftRailW(g) + MIN_CENTER_W, snap(g.w - rw));
    }
    layoutDockedNodes(g, curGraph(), { shrinkHeightToFit: true });
    invalidateHidden();
    updateHideCSS();
    markChanged();
}

// ── Membros do Grupo, Fold e Ocultação de Nós/Fios ─────────────────────────
function containedNodes(g) {
    const graph = curGraph();
    if (!graph) return [];
    ensureDockArrays(g);
    const dockedSet = new Set([
        ...g.getNodeIds.map(String),
        ...g.setNodeIds.map(String)
    ]);
    const out = [];
    for (const n of (graph._nodes || [])) {
        if (!n || !n.pos) continue;
        if (dockedSet.has(String(n.id))) {
            out.push(n);
            continue;
        }
        const b = nodeVisualBounds(n);
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h) {
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
    g.folded = false;
    g.h = Math.max(MIN_GROUP_H, snap(g.hOpen || MIN_GROUP_H));
    g.w = Math.max(minGroupWidth(g), snap(g.wOpen || g.w));
    delete g.foldNodes;
    delete g.foldGroups;
    layoutDockedNodes(g);
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
        layoutDockedNodes(g);
    }
    e.preventDefault();
    e.stopPropagation();
    repaint();
}

function onDragUp() {
    if (!_drag) return;
    const g = _drag.g;
    _drag = null;
    stopWinDrag();
    if (_pendingEvmSelect != null) {
        const gid = _pendingEvmSelect;
        _pendingEvmSelect = null;
        const targetG = ensureEvmGroups().find(x => x.id === gid);
        if (targetG) selectEvmGroup(targetG);
    }
    if (g) layoutDockedNodes(g);
    markChanged();
}

function onGlobalPointerUp(e) {
    _lmbDown = false;
    _carry = null;

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

    if (changed) markChanged();
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
                layoutDockedNodes(owner.group, this.graph || curGraph(), { shrinkHeightToFit: true });
            }
        } catch (_e) {}
        return res;
    };

    if (GetNodeClass && GetNodeClass.prototype && !GetNodeClass.prototype._evmRenameHooked) {
        const origOnRename = GetNodeClass.prototype.onRename;
        GetNodeClass.prototype.onRename = function () {
            const r = origOnRename?.apply(this, arguments);
            try {
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
                    layoutDockedNodes(owner.group, this.graph || curGraph(), { shrinkHeightToFit: true });
                }
            } catch (_e) {}
            return r;
        };
        GetNodeClass.prototype._evmRenameHooked = true;
    }

    _setNodeHooked = true;
}

// ── Persistência no Workflow (graph.extra.evmGroups) ────────────────────────
function installPersistence() {
    const G = app.graph?.constructor?.prototype || window.LGraph?.prototype;
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
        const r = origConfigure.apply(this, arguments);
        try {
            if (!this.extra) this.extra = {};
            const arr = data?.extra?.evmGroups;
            this.extra.evmGroups = Array.isArray(arr) ? arr.map(x => ({ ...x })) : [];
            if (this === curGraph()) {
                for (const g of this.extra.evmGroups) {
                    migrateLegacyColorsIfNeeded(g);
                    layoutDockedNodes(g, this);
                }
                invalidateHidden();
                updateHideCSS();
            }
        } catch (_e) {}
        return r;
    };
    G._evmGroupPersistWrapped = true;
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
const EVM_GROUP_TOOLBOX_CMD = "evm.selectionToolbox.evmGroup";

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
            #evm-group-floating-bar .evm-pill-fold {
                border: 1px solid rgba(72, 255, 132, 0.86);
                background: rgba(5, 30, 14, 0.98);
                color: #dfffe8;
            }
            #evm-group-floating-bar .evm-pill-fold:hover {
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

    floatingBar.querySelector(".evm-btn-fold")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentTarget?.type === "evmgroup") {
            const list = currentTarget.targets?.length ? currentTarget.targets : [currentTarget.target];
            for (const g of list) toggleFoldEvmGroup(g);
            setTimeout(updateGroupFloatingBar, 30);
        }
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
        const evmGroups = getSelectedEvmGroups();
        if (!evmGroups.length) return;

        // 1. Integração direta com a barra EasyKit NodeAlignPro (#hNodeAlignKit)
        const alignBtn = e.target?.closest?.("#hNodeAlignKit button");
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
            return [EVM_GROUP_TOOLBOX_CMD];
        }
        return [];
    },

    getCanvasMenuItems(canvas) {
        const gm = canvas?.graph_mouse || app.canvas?.graph_mouse;
        const p = gm ? [gm[0], gm[1]] : null;
        const overEvm = p ? evmGroupAt(p) : null;
        const overPix = (!overEvm && p && window.PixaromaPixGroup?.groupAt) ? window.PixaromaPixGroup.groupAt(p) : null;

        const items = [
            null,
            { content: "⚡ Add EVM Group (Set/Get)", callback: () => createEvmGroup(p) },
        ];

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
            repaint,
        };
        window.EVMAdvancedGroup = window.EVMGroupSetGet;

        console.log("[ComfyUI-EVM-Advanced-Group] Inicializado com sucesso (Settings nativos ⚡ EVM Advanced Group + Grid 3 quadradinhos + Auto-Reflow).");
    },
});
