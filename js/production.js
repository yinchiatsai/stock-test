(function () {
  "use strict";
  // V3.48 production analyzer; inventory mapping status now reads the same formal inventory source as deduction planning.

  const DEFAULT_SOURCE_MAP = {
    P: "Pinkoi",
    p: "Pinkoi",
    G: "LINE GIFT",
    LINE: "官方 LINE",
    WEB: "官網",
    MOMO: "MOMO",
    B2B: "企業訂單"
  };

  const DEFAULT_TAGS = [
    "急件", "特急", "更特急", "快過期", "今天過期", "今日過期",
    "先刻", "先印", "補", "補件", "補寄", "樣品", "老闆分"
  ];

  const RULE_STORAGE_KEY = "GB_PRODUCTION_ANALYZER_RULES_V1";
  const runtimeRules = loadRuntimeRules();

  function loadRuntimeRules() {
    try {
      const raw = localStorage.getItem(RULE_STORAGE_KEY);
      if (!raw) return { customSources: {}, customTags: [], ignoredTokens: [], ignoredIssues: [], manualItems: {}, productAliases: {}, statsOnlyProducts: {} };
      return { customSources: {}, customTags: [], ignoredTokens: [], ignoredIssues: [], manualItems: {}, productAliases: {}, statsOnlyProducts: {}, ...JSON.parse(raw) };
    } catch (error) {
      return { customSources: {}, customTags: [], ignoredTokens: [], ignoredIssues: [], manualItems: {}, productAliases: {}, statsOnlyProducts: {} };
    }
  }

  function saveRuntimeRules() {
    localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(runtimeRules));
  }

  function sourceMap() {
    return { ...DEFAULT_SOURCE_MAP, ...(runtimeRules.customSources || {}) };
  }

  function tagSet() {
    return new Set([...DEFAULT_TAGS, ...(runtimeRules.customTags || [])]);
  }

  function normalizeTagName(tag) {
    return tag === "補" ? "補件" : tag;
  }
  const SIDE_WORDS = ["正", "背", "反", "正面", "背面", "反面"];
  const PRODUCTION_ATTRIBUTE_FAMILIES = {
    side: ["正", "背", "反", "正面", "背面", "反面"],
    printLayer: ["白", "彩", "白檔", "彩檔", "底白", "底色", "鏡彩", "正彩"],
    insideOutside: ["內", "内", "外", "裡", "裡面", "里面", "外面"],
    faceCount: ["單", "单", "雙", "双", "單面", "双面", "雙面"],
    engraving: ["有刻", "沒刻", "无刻", "不刻", "刻白", "刻黑"],
    presentationFace: ["旋轉面"]
  };
  const KNOWN_PRODUCTION_ATTRIBUTES = Object.values(PRODUCTION_ATTRIBUTE_FAMILIES).flat();
  const KNOWN_COLORS = ["玫瑰金", "玫瑰", "霧黑", "霧銀", "霧金", "胡桃棕", "花梨木", "原木", "透明", "奶茶", "深", "淺", "大", "小", "金", "銀", "黑", "白", "紅", "藍", "綠", "紫", "粉", "灰"];
  const IGNORE_PRODUCT_WORDS = ["刻白", "刻黑", "雕白", "雕黑", "雷雕", "彩印", "白墨", "底白", "有刻", "沒刻", "无刻", "不刻", "鏡彩", "正彩"];
  const DESIGNER_CODE_RE = /^\d+[A-Z]{2,4}$/i;

  let lastAnalysis = null;
  let lastRawEntries = [];
  let lastAnalysisOptions = null;
  let currentSession = createEmptySession();
  let productSearchTerm = "";
  let productViewMode = "all";
  let lastProductChanges = new Map();
  let learningSearchTerm = "";
  let selectedProductName = "";
  // V3.26: 拖曳進來的多資料夾檔案，獨立於原生 file input 保存。
  let droppedProductionEntries = [];
  // 已完成分析的拖曳來源檔；同一工作階段再次按分析時只處理新增檔案。
  let analyzedDroppedEntryKeys = new Set();
  let droppedBatchDuplicateCounts = new Map();
  let droppedBatchLastAddedAt = new Map();
  let lastProductionTransactionId = "";

  function createEmptySession() {
    return {
      id: `session-${Date.now()}`,
      label: "尚未建立",
      records: [],
      sources: [],
      updatedAt: ""
    };
  }

  function $(id) {
    return document.getElementById(id);
  }

  function todayString() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function stripExtension(name) {
    return String(name || "").replace(/\.[^./\\]+$/, "");
  }

  function splitPath(path) {
    return String(path || "").replace(/＿/g, "_").split(/[\\/]+/).filter(Boolean);
  }

  function firstProductionPart(base) {
    return String(base || "").replace(/＿/g, "_").split("_")[0].trim();
  }

  function stripFilenameDateBatchPrefix(text) {
    let value = String(text || "").replace(/＿/g, "_").trim();
    const parts = value.split("_");
    if (!parts.length) return value;

    const token = String(parts[0] || "").trim();
    let isDateToken = false;

    // MMDD，例如 0903
    if (/^\d{4}$/.test(token)) {
      const month = Number(token.slice(0, 2));
      const day = Number(token.slice(2, 4));
      isDateToken = month >= 1 && month <= 12 && day >= 1 && day <= 31;
    }

    // 民國 YYYMMDD，例如 1150909
    if (!isDateToken && /^\d{7}$/.test(token)) {
      const month = Number(token.slice(3, 5));
      const day = Number(token.slice(5, 7));
      isDateToken = month >= 1 && month <= 12 && day >= 1 && day <= 31;
    }

    // 西元 YYYYMMDD，例如 20260910
    if (!isDateToken && /^\d{8}$/.test(token)) {
      const year = Number(token.slice(0, 4));
      const month = Number(token.slice(4, 6));
      const day = Number(token.slice(6, 8));
      isDateToken = year >= 2000 && year <= 2199 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
    }

    if (!isDateToken) return value;

    // 日期後若緊接純數字批次（例：0903_02_商品），一起略過。
    let startIndex = 1;
    if (parts.length > 2 && /^\d{1,3}$/.test(String(parts[1] || "").trim())) startIndex = 2;
    return parts.slice(startIndex).join("_").trim();
  }

  function stripLeadingTokens(text) {
    let rest = String(text || "").trim();
    const tokens = [];
    let changed = true;
    while (changed) {
      changed = false;
      const match = rest.match(/^\s*[（(]([^()（）]+)[）)]\s*/);
      if (match) {
        tokens.push(match[1].trim());
        rest = rest.slice(match[0].length).trim();
        changed = true;
      }
    }
    return { tokens, rest };
  }

  function classifyTokens(tokens) {
    let source = "蝦皮";
    const tags = [];
    const unknownStartTokens = [];
    const sources = sourceMap();
    const tagsKnown = tagSet();
    const ignored = new Set(runtimeRules.ignoredTokens || []);

    tokens.forEach(raw => {
      const token = raw.trim();
      if (!token || ignored.has(token)) return;
      if (sources[token]) {
        source = sources[token];
      } else if (tagsKnown.has(token)) {
        tags.push(normalizeTagName(token));
      } else {
        unknownStartTokens.push(token);
      }
    });

    return { source, tags: Array.from(new Set(tags)), unknownStartTokens };
  }

  function parseParenGroups(text) {
    const groups = [];
    const re = /[（(]([^()（）]+)[）)]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      groups.push({ text: m[1].trim(), start: m.index, end: re.lastIndex });
    }
    return groups;
  }

  function parseColorList(text) {
    const normalized = String(text || "")
      .replace(/、/g, ",")
      .replace(/，/g, ",")
      .replace(/[＿_]/g, ",");
    return normalized.split(",").map(x => x.trim()).filter(Boolean);
  }

  function isColorOrProductionAttributeToken(text) {
    const token = String(text || "").trim();
    if (!token) return true;
    if (KNOWN_COLORS.includes(token)) return true;
    if (normalizeProductionAttribute(token).attribute) return true;
    return false;
  }

  function colorsFromSpecText(text) {
    const parts = parseColorList(text)
      .map(x => x.replace(/^(左|右|上|下|前|後|后)/, "").trim())
      .filter(Boolean);
    const colors = [];
    parts.forEach(part => {
      if (KNOWN_COLORS.includes(part)) colors.push(part);
    });
    return Array.from(new Set(colors));
  }

  function isKnownColorText(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (KNOWN_COLORS.includes(value)) return true;
    if (/[，,、＿_]/.test(value)) {
      const parts = parseColorList(value);
      const colorCount = parts.filter(part => KNOWN_COLORS.includes(part)).length;
      // 允許括號內混合「顏色 + 製作/加工屬性」，例如：(銀_單)、(黑_雙)
      return colorCount > 0 && parts.every(part => isColorOrProductionAttributeToken(part));
    }
    return false;
  }

  function colorsFromLastMeaningfulGroup(text, groups, stopIndex) {
    for (let i = stopIndex; i >= 0; i--) {
      const group = groups[i];
      if (!group) continue;
      if (isKnownColorText(group.text)) return colorsFromSpecText(group.text);
    }
    return [];
  }

  function parseProductAndQty(rawText) {
    const normalizedRaw = String(rawText || "").replace(/＿/g, "_").trim();
    const rawParts = normalizedRaw.split("_").map(x => x.trim()).filter(Boolean);
    let text = firstProductionPart(normalizedRaw).trim();

    // 支援「商品_(規格)x數量_客人_製作屬性」命名。
    // 括號前若以底線分隔，仍視為商品規格的一部分；例如：樟木杯墊_(方)x4。
    if (rawParts.length >= 2) {
      const specQtyPart = rawParts[1];
      if (/^[（(][^()（）]+[）)]\s*[xX×]\s*\d+$/.test(specQtyPart)) {
        text = `${rawParts[0]}${specQtyPart}`;
      }
    }
    const issues = [];

    // 支援括號內直接寫「銀_玫瑰各x1」：各xN 套用到前面所有顏色。
    // 例如：軍牌(單)(銀_玫瑰各x1)_客人 → 銀x1 + 玫瑰x1。
    const fullGroups = parseParenGroups(normalizedRaw);
    for (const group of fullGroups) {
      const m = String(group.text || "").match(/^(.*?)各\s*[xX×]\s*(\d+)$/);
      if (!m) continue;
      const specs = parseColorList(m[1]).filter(Boolean);
      const colors = specs.filter(spec => KNOWN_COLORS.includes(spec));
      if (!colors.length || colors.length !== specs.length) continue;
      const perColor = Number(m[2]);
      const base = normalizedRaw.slice(0, group.start).trim();
      return {
        product: cleanProduct(base),
        quantity: colors.length * perColor,
        unitHint: "件",
        colors,
        perColorQty: perColor,
        variantDetails: colors.map(color => ({ name: color, quantity: perColor })),
        qtyMode: "inline-same-color-qty",
        issues
      };
    }

    if (!text) {
      return { product: "", quantity: 0, unitHint: "件", colors: [], qtyMode: "error", issues: ["缺少商品名稱"] };
    }

    const groups = parseParenGroups(text);
    const last = groups[groups.length - 1];

    // 多色，每色同數量：軍牌(單)(金,銀,玫瑰,黑)(各x20)
    if (last) {
      const sameQty = last.text.match(/^各\s*[xX×]\s*(\d+)$/);
      if (sameQty) {
        const prev = groups[groups.length - 2];
        const colors = prev ? parseColorList(prev.text) : [];
        const perColor = Number(sameQty[1]);
        const base = prev ? text.slice(0, prev.start).trim() : text.slice(0, last.start).trim();
        if (!colors.length) issues.push("使用(各x數量)但找不到顏色清單");
        return {
          product: cleanProduct(base),
          quantity: colors.length ? colors.length * perColor : perColor,
          unitHint: "件",
          colors,
          perColorQty: perColor,
          variantDetails: colors.map(color => ({ name: color, quantity: perColor })),
          qtyMode: "same-color-qty",
          issues
        };
      }
    }

    // 多色，每色不同數量：軍牌(單)(金x10,銀x20)
    if (last && /[,，、]/.test(last.text) && /[xX×]\s*\d+/.test(last.text)) {
      const parts = parseColorList(last.text);
      const colors = [];
      const variantDetails = [];
      let total = 0;
      let ok = true;
      parts.forEach(part => {
        const m = part.match(/^(.+?)\s*[xX×]\s*(\d+)$/);
        if (!m) {
          ok = false;
          issues.push(`顏色數量格式無法解析：${part}`);
          return;
        }
        const color = m[1].trim();
        const qty = Number(m[2]);
        colors.push(color);
        variantDetails.push({ name: color, quantity: qty });
        total += qty;
      });
      if (ok) {
        return {
          product: cleanProduct(text.slice(0, last.start).trim()),
          quantity: total,
          unitHint: "件",
          colors,
          variantDetails,
          qtyMode: "multi-color-different-qty",
          issues
        };
      }
    }

    // 一般數量：名牌(黑)(x20)
    if (last) {
      const qty = last.text.match(/^[xX×]\s*(\d+)$/);
      if (qty) {
        const colors = colorsFromLastMeaningfulGroup(text, groups, groups.length - 2);
        return {
          product: cleanProduct(text.slice(0, last.start).trim()),
          quantity: Number(qty[1]),
          unitHint: "件",
          colors,
          qtyMode: "explicit-qty",
          issues
        };
      }
      if (/^[xX×]/.test(last.text) || /\d+/.test(last.text) && /[xX×]/.test(last.text)) {
        issues.push(`數量格式可能錯誤：(${last.text})`);
      }
    }

    // 相容舊式尾端數量：手機架(深)x2、名牌(黑)X20
    const trailingQty = text.match(/^(.*?)[xX×]\s*(\d+)$/);
    if (trailingQty && trailingQty[1].trim()) {
      const productText = trailingQty[1].trim();
      const productGroups = parseParenGroups(productText);
      const colors = colorsFromLastMeaningfulGroup(productText, productGroups, productGroups.length - 1);
      return {
        product: cleanProduct(productText),
        quantity: Number(trailingQty[2]),
        unitHint: "件",
        colors,
        qtyMode: "trailing-qty",
        issues: [...issues, "使用舊式尾端數量寫法，建議改為：(x數量)，例如：商品(深)(x2)"]
      };
    }

    // 舊格式輔助：軍牌(單)上到下 金 銀 玫瑰 黑
    const afterGroups = text.replace(/[（(][^()（）]+[）)]/g, " ");
    const colorHits = KNOWN_COLORS.filter(color => new RegExp(`(^|\\s)${escapeRegExp(color)}($|\\s)`).test(afterGroups));
    if (colorHits.length >= 2 && /上到下|由上到下|顏色|色/.test(text)) {
      const productPart = text.split(/上到下|由上到下|顏色|色/)[0].trim();
      return {
        product: cleanProduct(productPart),
        quantity: colorHits.length,
        unitHint: "件",
        colors: colorHits,
        variantDetails: colorHits.map(color => ({ name: color, quantity: 1 })),
        qtyMode: "legacy-color-count",
        issues: ["使用舊式多色寫法，建議改為：商品(顏色1,顏色2)(各x數量)"]
      };
    }

    return {
      product: cleanProduct(text),
      quantity: 1,
      unitHint: "件",
      colors: colorsFromLastMeaningfulGroup(text, groups, groups.length - 1),
      qtyMode: "default-1",
      issues
    };
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cleanProduct(product) {
    let value = String(product || "")
      .replace(/[，,、]+$/g, "")
      .replace(/\s+/g, "")
      .trim();
    IGNORE_PRODUCT_WORDS.forEach(word => {
      value = value.replace(new RegExp(escapeRegExp(word), "g"), "");
    });
    // 單/雙/正/背/反/白/彩/內/外等是製作屬性；已知顏色/尾端規格也不應成為商品主名。
    value = value.replace(/[（(]([^()（）]+)[）)]/g, (full, inner) => {
      const text = String(inner || "").trim();
      if (normalizeProductionAttribute(text).attribute) return "";
      if (isKnownColorText(text)) return "";
      const parts = parseColorList(text);
      if (parts.length && parts.every(part => isColorOrProductionAttributeToken(part))) return "";
      return full;
    });
    value = value
      .replace(/(單面|雙面|双面)$/g, "")
      .replace(/[，,、]+$/g, "")
      .trim();
    return value.trim();
  }

  function normalizedBaseName(baseName) {
    return stripExtension(baseName).replace(/＿/g, "_").trim();
  }

  function normalizeProductionAttribute(attr) {
    const value = String(attr || "").replace(/\d+$/g, "").trim();
    if (["正", "正面"].includes(value)) return { attribute: "正", family: "side" };
    if (["背", "背面"].includes(value)) return { attribute: "背", family: "side" };
    if (["反", "反面"].includes(value)) return { attribute: "反", family: "side" };
    if (["旋轉面"].includes(value)) return { attribute: "旋轉面", family: "presentationFace" };
    if (["白", "白檔", "底白", "底色"].includes(value)) return { attribute: "白", family: "printLayer" };
    if (["彩", "彩檔"].includes(value)) return { attribute: "彩", family: "printLayer" };
    if (["鏡彩"].includes(value)) return { attribute: "鏡彩", family: "printLayer" };
    if (["正彩"].includes(value)) return { attribute: "正彩", family: "printLayer" };
    if (["內", "内", "裡", "裡面", "里面"].includes(value)) return { attribute: "內", family: "insideOutside" };
    if (["外", "外面"].includes(value)) return { attribute: "外", family: "insideOutside" };
    if (["單", "单", "單面"].includes(value)) return { attribute: "單", family: "faceCount" };
    if (["雙", "双", "雙面", "双面"].includes(value)) return { attribute: "雙", family: "faceCount" };
    if (["有刻"].includes(value)) return { attribute: "有刻", family: "engraving" };
    if (["沒刻", "无刻", "不刻"].includes(value)) return { attribute: "沒刻", family: "engraving" };
    return { attribute: "", family: "" };
  }

  function detectAttachedPrintLayer(baseName) {
    const text = normalizedBaseName(baseName);
    const segments = text.split(/[_-]+/).map(x => x.trim()).filter(Boolean);
    // 商品顏色使用括號表示，例如 (白)。沒有括號且直接黏在片段尾端的 白/彩/白檔/彩檔/鏡彩/正彩
    // 視為製作屬性，例如：識別證...3CX白_2PJ、識別證...3CX彩_2PJ。
    for (const segment of segments) {
      if (!segment || /[）)]$/.test(segment)) continue;
      const m = segment.match(/(白檔|彩檔|鏡彩|正彩|白|彩)$/);
      if (!m) continue;
      const prefix = segment.slice(0, -m[1].length);
      if (!prefix) continue; // 獨立 _白_ / _彩_ 交給原本規則
      return normalizeProductionAttribute(m[1]);
    }
    return { attribute: "", family: "" };
  }

  function stripAttachedPrintLayer(value) {
    return String(value || "")
      .replace(/(白檔|彩檔|鏡彩|正彩|白|彩)$/g, "")
      .trim();
  }

  function detectSharedSideSegment(baseName) {
    const text = normalizedBaseName(baseName);
    const segments = text.split(/[_-]+/).map(x => x.trim()).filter(Boolean);
    for (const segment of segments) {
      let m = segment.match(/^(正面?|背面?|反面?)同圖[xX×]\s*(\d+)$/);
      if (m) {
        const normalized = normalizeProductionAttribute(m[1]);
        return {
          type: "shared",
          side: normalized.attribute,
          role: normalized.attribute === "正" ? "front" : "back",
          quantity: Number(m[2]),
          segment
        };
      }
      m = segment.match(/^(正面?|背面?|反面?)(\d+)$/);
      if (m) {
        const normalized = normalizeProductionAttribute(m[1]);
        return {
          type: "individual",
          side: normalized.attribute,
          role: normalized.attribute === "正" ? "front" : "back",
          index: Number(m[2]),
          quantity: 1,
          segment
        };
      }
    }
    return null;
  }

  function detectProductionAttribute(baseName) {
    const sharedSide = detectSharedSideSegment(baseName);
    if (sharedSide) return normalizeProductionAttribute(sharedSide.side);
    const text = normalizedBaseName(baseName);
    const segments = text.split(/[_-]+/).map(x => x.trim()).filter(Boolean);
    for (const segment of segments) {
      const normalized = normalizeProductionAttribute(segment);
      if (normalized.attribute) return normalized;
    }
    const m = text.match(/[_-](旋轉面|正面?|背面?|反面?|白檔?|彩檔?|底白|底色|鏡彩|正彩|內|内|外|裡面?|里面|外面|單面?|单|雙面?|双面?|有刻|沒刻|无刻|不刻)\d*($|[_-])/);
    if (m) return normalizeProductionAttribute(m[1]);
    const attached = detectAttachedPrintLayer(text);
    if (attached.attribute) return attached;
    return { attribute: "", family: "" };
  }

  function detectSide(baseName) {
    const detected = detectProductionAttribute(baseName);
    return detected.family === "side" ? detected.attribute : "";
  }

  function isIgnoredFilenameSegment(segment) {
    const value = String(segment || "").trim();
    if (!value) return true;
    if (DESIGNER_CODE_RE.test(value)) return true;
    if (normalizeProductionAttribute(value).attribute) return true;
    if (/^\d+[A-Z]{2,4}$/i.test(value)) return true;
    return false;
  }

  function detectTrailingVariant(baseName) {
    const text = normalizedBaseName(baseName);
    const segments = text.split(/[_-]+/).map(x => x.trim()).filter(Boolean);
    if (segments.length < 2) return "";
    for (let i = segments.length - 1; i >= 1; i--) {
      const seg = segments[i];
      if (isIgnoredFilenameSegment(seg)) continue;
      if (KNOWN_COLORS.includes(seg)) return seg;
      break;
    }
    return "";
  }

  function detectAnyVariant(baseName) {
    const variants = detectFilenameVariants(baseName);
    return variants[0] || "";
  }

  function detectFilenameVariants(baseName) {
    const text = normalizedBaseName(baseName);
    const colors = [];
    const pushColor = color => {
      const c = String(color || "").trim();
      if (c && KNOWN_COLORS.includes(c) && !colors.includes(c)) colors.push(c);
    };

    // 括號內顏色/規格，例如：薄款金屬卡(銀_單)、黑筆(銀)
    parseParenGroups(text).forEach(group => {
      colorsFromSpecText(group.text).forEach(pushColor);
    });

    // 底線/連字號片段中的「獨立製作屬性」不可當成商品顏色。
    // 規則：商品顏色若是白色，應以 (白) 表示；_白_ / _彩_ / _正彩_ / _鏡彩_ 等優先視為製作檔屬性。
    // 其他確實以底線帶出的顏色仍保留支援，例如：極細筆_玫瑰、右玫瑰、左黑、上銀、下黑。
    text.split(/[_-]+/).map(x => x.trim()).filter(Boolean).forEach(seg => {
      const rawSegment = seg.replace(/[()（）]/g, "").trim();
      if (normalizeProductionAttribute(rawSegment).attribute) return;

      let cleaned = rawSegment;
      cleaned = cleaned.replace(/^(左|右|上|下|前|後|后)/, "").trim();
      cleaned = cleaned.replace(/\d+$/g, "").trim();
      // 去掉方向字後如果剛好變成製作屬性，也不要當顏色。
      if (normalizeProductionAttribute(cleaned).attribute) return;
      pushColor(cleaned);
    });

    return colors;
  }

  function removeProductionAttributesForIdentity(baseName) {
    const text = normalizedBaseName(baseName);
    return text
      .split(/([_-]+)/)
      .map(part => {
        if (/^[_-]+$/.test(part)) return part;
        if (detectSharedSideSegment(part)) return "";
        if (normalizeProductionAttribute(part).attribute) return "";
        const attached = detectAttachedPrintLayer(part);
        return attached.attribute ? stripAttachedPrintLayer(part) : part;
      })
      .join("")
      .replace(/[_-]{2,}/g, "_")
      .replace(/^[_-]+|[_-]+$/g, "")
      .trim();
  }

  function folderParseCandidate(pathParts) {
    // 從最靠近檔案的資料夾往前找，有商品數量的資料夾就優先。
    for (let i = pathParts.length - 2; i >= 0; i--) {
      const folder = pathParts[i];
      const parsed = parseFullName(folder);
      if (parsed.product && parsed.quantity > 1 || /[（(](?:x|X|×|各x|各X|各×)\s*\d+[）)]/.test(folder)) {
        return { folder, parsed };
      }
    }
    return null;
  }


  function normalizeFolderDate(value) {
    const text = String(value || "").trim();
    let m = text.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})$/);
    if (m) {
      const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
    m = text.match(/^(\d{3})[-/.]?(\d{2})[-/.]?(\d{2})$/);
    if (m) {
      const rocYear = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      if (rocYear >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const year = rocYear + 1911;
        return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
    return "";
  }

  function inferDateFromPath(pathParts) {
    for (const part of (pathParts || [])) {
      const normalized = normalizeFolderDate(part);
      if (normalized) return normalized;
    }
    return "";
  }

  function isDateInRange(date, start, end) {
    if (!date) return true;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  }

  function inferProcess(pathParts, dateValue) {
    if (!pathParts.length) return "未指定";
    const candidates = pathParts.slice(0, -1).filter(Boolean);
    const idx = candidates.findIndex(p => normalizeFolderDate(p) === dateValue);
    // V3.26：支援「日期/製程/檔案」以及「製程/日期/檔案」兩種常見結構。
    if (idx >= 0 && idx < candidates.length - 1) return candidates[idx + 1] || "未指定";
    if (idx > 0) return candidates[idx - 1] || "未指定";
    // 沒有日期資料夾時，最靠近檔案的資料夾視為製程名稱。
    return candidates[candidates.length - 1] || "未指定";
  }

  function parseFullName(name) {
    const base = stripExtension(name);
    // V3.38：部分製程資料的每個檔名都固定以前綴「日期_批次_」開頭。
    // 例如 0903_02_U型袋(小)_單_...；日期/批次只作識別資訊，不參與商品名稱解析。
    const baseWithoutDateBatch = stripFilenameDateBatchPrefix(base);
    const leading = stripLeadingTokens(baseWithoutDateBatch);
    const classified = classifyTokens(leading.tokens);
    const parsed = parseProductAndQty(leading.rest);
    return {
      source: classified.source,
      tags: classified.tags,
      unknownStartTokens: classified.unknownStartTokens,
      product: parsed.product,
      quantity: parsed.quantity,
      unitHint: parsed.unitHint,
      colors: parsed.colors || [],
      perColorQty: parsed.perColorQty || "",
      variantDetails: parsed.variantDetails || [],
      qtyMode: parsed.qtyMode,
      unknownStartTokens: classified.unknownStartTokens,
      issues: [...(parsed.issues || []), ...classified.unknownStartTokens.map(t => `未知開頭標記：(${t})`)]
    };
  }



  function buildStockDetails(parsed) {
    const product = parsed.product || "未解析";
    const qty = Number(parsed.quantity || 0);
    const variants = parsed.variantDetails || [];

    if (variants.length) {
      return variants.map(v => ({
        item: product.includes(`(${v.name})`) ? product : `${product}(${v.name})`,
        variant: v.name,
        quantity: Number(v.quantity || 0),
        unit: parsed.unitHint || "件",
        note: "多色拆扣"
      }));
    }

    const singleColor = (parsed.colors && parsed.colors.length === 1) ? parsed.colors[0] : "";
    return [{
      item: singleColor && !product.includes(`(${singleColor})`) ? `${product}(${singleColor})` : product,
      variant: singleColor,
      quantity: qty,
      unit: parsed.unitHint || "件",
      note: "一般扣庫存"
    }];
  }

  function stockDetailsText(details) {
    return (details || [])
      .filter(d => Number(d.quantity || 0) > 0)
      .map(d => `${d.item} × ${d.quantity}${d.unit || ""}`)
      .join("；") || "-";
  }

  function aliasTarget(product) {
    const aliases = runtimeRules.productAliases || {};
    return aliases[product] || product;
  }

  function rebuildStockDetailsForRecord(record) {
    const product = record.product || "未解析";
    const qty = Number(record.quantity || 0);
    const variants = record.variantDetails || [];
    if (variants.length) {
      record.stockDetails = variants.map(v => ({
        item: product.includes(`(${v.name})`) ? product : `${product}(${v.name})`,
        variant: v.name,
        quantity: Number(v.quantity || 0),
        unit: record.unit || "件",
        note: "多色拆扣"
      }));
    } else {
      const singleColor = (record.colors && record.colors.length === 1) ? record.colors[0] : "";
      record.stockDetails = [{
        item: singleColor && !product.includes(`(${singleColor})`) ? `${product}(${singleColor})` : product,
        variant: singleColor,
        quantity: qty,
        unit: record.unit || "件",
        note: "一般扣庫存"
      }];
    }
  }

  function applyProductAlias(record) {
    const target = aliasTarget(record.product);
    if (target && target !== record.product) {
      record.originalProduct = record.product;
      record.product = target;
      rebuildStockDetailsForRecord(record);
    }
    return record;
  }

  function rememberProductAlias(fromProduct, toProduct) {
    const from = String(fromProduct || "").trim();
    const to = String(toProduct || "").trim();
    if (!from || !to || from === to || from === "未解析") return;
    runtimeRules.productAliases = { ...(runtimeRules.productAliases || {}), [from]: to };
    saveRuntimeRules();
  }

  function applyProductToRecord(record, product, quantity, note) {
    const target = String(product || "").trim();
    if (!record || !target) return;
    record.product = target;
    if (Number.isFinite(quantity) && quantity >= 0) {
      record.quantity = quantity;
      record.countedQuantity = quantity;
    }
    record.variantDetails = [];
    record.colors = [];
    rebuildStockDetailsForRecord(record);
    record.issues = (record.issues || []).filter(issue => !/缺少商品名稱|無法判斷商品名稱|數量無法判斷/.test(issue));
    if (note) record.manualNote = note;
  }

  function issueKey(filename, issue) {
    return `${filename}||${issue}`;
  }

  function learnedMappingKey(record, fallbackName = "") {
    const name = String(record?.originalParsedProduct || record?.originalProduct || fallbackName || record?.product || "").trim();
    const variants = Array.from(new Set([
      ...((record?.originalColors || record?.colors || []).map(v => String(v || "").trim())),
      ...((record?.originalVariantDetails || record?.variantDetails || []).map(v => String(v?.name || "").trim()))
    ].filter(Boolean))).sort();
    return variants.length ? `${name}||規格:${variants.join("+")}` : name;
  }

  function learnedMappingLabel(record, fallbackName = "") {
    const name = String(record?.originalParsedProduct || record?.originalProduct || fallbackName || record?.product || "").trim();
    const variants = Array.from(new Set([
      ...((record?.originalColors || record?.colors || []).map(v => String(v || "").trim())),
      ...((record?.originalVariantDetails || record?.variantDetails || []).map(v => String(v?.name || "").trim()))
    ].filter(Boolean))).sort();
    return variants.length ? `${name}（${variants.join("、")}）` : name;
  }

  function applyManualItem(record) {
    const manual = runtimeRules.manualItems?.[record.path] || runtimeRules.manualItems?.[record.filename];
    const learnedKey = learnedMappingKey(record);
    // 有規格/顏色的商品只讀取「商品＋規格」規則，避免舊的商品級規則把淺/深等不同細項一起覆蓋。
    const hasVariantScope = learnedKey.includes("||規格:");
    const learned = runtimeRules.productManualMappings?.[learnedKey] || (!hasVariantScope ? (runtimeRules.productManualMappings?.[record.originalParsedProduct] || runtimeRules.productManualMappings?.[record.product]) : null);
    const rule = manual || learned;
    if (!rule) return record;
    if (rule.details?.length) {
      const baseQty = Number(record.countedQuantity || record.quantity || 1) || 1;
      const details = (rule.details || []).map(d => ({
        ...d,
        quantity: rule.mode === "per-unit"
          ? Math.max(1, Math.round(Number(d.perUnitQty ?? d.quantity ?? 1) * baseQty))
          : Math.max(1, Math.round(Number(d.quantity || 1)))
      }));
      applyStockDetailsToRecord(record, details, manual ? "本次人工指定" : "永久指定");
      return record;
    }
    if (rule.product) {
      record.product = rule.product;
      record.stockDetails = [{
        item: rule.product,
        variant: "",
        quantity: Number(rule.quantity || record.quantity || 1),
        unit: record.unit || "件",
        note: manual ? "本次人工指定" : "永久指定"
      }];
      record.quantity = Number(rule.quantity || record.quantity || 1);
      record.countedQuantity = record.quantity;
      record.issues = record.issues.filter(issue => !/缺少商品名稱|無法判斷商品名稱|數量無法判斷/.test(issue));
    }
    return record;
  }

  function applyIgnoredIssues(record) {
    const ignoredIssues = new Set(runtimeRules.ignoredIssues || []);
    record.issues = (record.issues || []).filter(issue => !ignoredIssues.has(issueKey(record.filename, issue)));
    return record;
  }

  function parseEntry(entry, dateValue) {
    const pathParts = splitPath(entry.path || entry.filename);
    const filename = entry.filename || pathParts[pathParts.length - 1] || "";
    const base = stripExtension(filename);
    const inferredDate = inferDateFromPath(pathParts);
    const actualDate = inferredDate || dateValue || "";
    const process = entry.process || inferProcess(pathParts, actualDate);
    const folderCandidate = pathParts.length > 1 ? folderParseCandidate(pathParts) : null;
    const parsed = folderCandidate ? folderCandidate.parsed : parseFullName(filename);
    const filenameVariants = detectFilenameVariants(base);
    const trailingVariant = detectTrailingVariant(base) || filenameVariants[0] || "";
    if (parsed.product && !parsed.colors?.length && !(parsed.variantDetails || []).length) {
      const variants = filenameVariants.length ? filenameVariants : (trailingVariant ? [trailingVariant] : []);
      if (variants.length === 1) {
        parsed.colors = variants;
        parsed.qtyMode = parsed.qtyMode === "default-1" ? "trailing-variant-default-1" : parsed.qtyMode;
      } else if (variants.length > 1) {
        parsed.colors = variants;
        // 若檔名中出現多個顏色且總數量等於顏色數，視為每色各 1；否則先平均可整除，避免把多色全部合成同一品項。
        const totalQty = Number(parsed.quantity || 1);
        const per = totalQty % variants.length === 0 ? totalQty / variants.length : 1;
        parsed.variantDetails = variants.map(color => ({ name: color, quantity: per }));
        parsed.quantity = totalQty >= variants.length ? totalQty : variants.length;
        parsed.qtyMode = "filename-multi-variant";
      }
    }
    const detectedAttribute = detectProductionAttribute(base);
    // 若白/彩是直接黏在商品片段尾端，從商品主名中移除，讓白檔和彩檔能落在同一品項。
    if (detectedAttribute.family === "printLayer" && detectAttachedPrintLayer(base).attribute) {
      parsed.product = stripAttachedPrintLayer(parsed.product);
    }
    const side = detectedAttribute.family === "side" ? detectedAttribute.attribute : "";
    const identity = removeProductionAttributesForIdentity(base);
    const issues = [...parsed.issues];

    if (!parsed.product) issues.push("無法判斷商品名稱");
    if (!Number.isFinite(parsed.quantity) || parsed.quantity <= 0) issues.push("數量無法判斷");

    const record = {
      date: actualDate,
      process,
      source: parsed.source,
      tags: parsed.tags,
      product: parsed.product || "未解析",
      originalParsedProduct: parsed.product || "未解析",
      quantity: parsed.quantity || 0,
      unit: parsed.unitHint || "件",
      colors: parsed.colors,
      originalColors: [...(parsed.colors || [])],
      perColorQty: parsed.perColorQty,
      variantDetails: parsed.variantDetails || [],
      originalVariantDetails: (parsed.variantDetails || []).map(v => ({ ...v })),
      stockDetails: buildStockDetails(parsed),
      qtyMode: parsed.qtyMode,
      side,
      productionAttribute: detectedAttribute.attribute,
      productionAttributeFamily: detectedAttribute.family,
      sharedSideInfo: detectSharedSideSegment(base),
      identity,
      filename,
      path: entry.path || filename,
      sourceSignature: entry.sourceSignature || `${actualDate}|${filename}`,
      folderPriority: !!folderCandidate,
      folderName: folderCandidate ? folderCandidate.folder : "",
      unknownStartTokens: parsed.unknownStartTokens || [],
      issues,
      mergedBySide: false,
      mergedByProductionAttribute: false,
      mergeReason: "",
      countedQuantity: parsed.quantity || 0
    };
    if (runtimeRules.statsOnlyProducts?.[record.originalParsedProduct] || runtimeRules.statsOnlyProducts?.[record.product]) {
      record.statsOnly = true;
      record.stockDetails = [];
      record.manualNote = "永久僅統計";
    }
    applyManualItem(record);
    applyProductAlias(record);
    applyIgnoredIssues(record);
    return record;
  }

  function entriesFromTextarea() {
    const text = $("productionFilenameInput")?.value || "";
    return text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const parts = splitPath(line);
        return { path: line, filename: parts[parts.length - 1] || line };
      });
  }

  function entriesFromFileInput() {
    const input = $("productionFileInput");
    const manualProcess = ($("productionProcessInput")?.value || "").trim();
    if (!input || !input.files) return [];
    return Array.from(input.files).map(file => {
      const path = file.webkitRelativePath || file.name;
      const parts = splitPath(path);
      return { path, filename: parts[parts.length - 1] || file.name, process: manualProcess || "", sourceSignature: `${path}` };
    });
  }

  function dedupeProductionEntries(entries) {
    const seen = new Set();
    return (entries || []).filter(entry => {
      const key = String(entry?.path || entry?.sourceSignature || entry?.filename || "").replace(/^\/+/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function productionEntryKey(entry) {
    return String(entry?.path || entry?.sourceSignature || entry?.filename || "").replace(/^\/+/, "");
  }

  function productionBatchInfo(entry) {
    const parts = splitPath(entry?.path || entry?.filename || "");
    const folder = parts.length > 1 ? parts[0] : "單一檔案";
    const date = inferDateFromPath(parts) || "無日期";
    const process = inferProcess(parts, date) || "未指定";
    // V3.37：使用者實際拖入的最外層資料夾就是一個批次。
    // 子資料夾（日期、製程、OK 等）只作為批次內資訊，不再拆成多批。
    const key = folder;
    return { key, folder, date, process };
  }

  function droppedFolderStates(entries = droppedProductionEntries) {
    const groups = new Map();
    (entries || []).forEach(entry => {
      const info = productionBatchInfo(entry);
      if (!groups.has(info.key)) groups.set(info.key, { ...info, dates: new Set(), processes: new Set(), total: 0, analyzed: 0, pending: 0, duplicateAttempts: droppedBatchDuplicateCounts.get(info.key) || 0, lastAddedAt: droppedBatchLastAddedAt.get(info.key) || "" });
      const group = groups.get(info.key);
      group.total += 1;
      if (info.date && info.date !== "無日期") group.dates.add(info.date);
      if (info.process && info.process !== "未指定" && info.process !== info.folder) group.processes.add(info.process);
      if (analyzedDroppedEntryKeys.has(productionEntryKey(entry))) group.analyzed += 1;
      else group.pending += 1;
    });
    return Array.from(groups.values()).map(group => {
      const dates = Array.from(group.dates).sort();
      const processes = Array.from(group.processes).sort((a,b) => a.localeCompare(b, "zh-Hant"));
      return {
        ...group,
        date: dates.length === 0 ? "無日期" : (dates.length === 1 ? dates[0] : `多日期（${dates.length}）`),
        process: processes.length === 0 ? "未指定" : (processes.length === 1 ? processes[0] : `含 ${processes.length} 個製程/子資料夾`)
      };
    }).sort((a, b) => {
      if ((a.pending > 0) !== (b.pending > 0)) return a.pending > 0 ? -1 : 1;
      return (b.lastAddedAt || "").localeCompare(a.lastAddedAt || "") || (a.folder || "").localeCompare(b.folder || "", "zh-Hant");
    });
  }

  function renderDroppedFolderSummary() {
    const folderText = $("productionSelectedFolderText");
    if (!folderText) return;
    const states = droppedFolderStates();
    if (!states.length) {
      folderText.textContent = "尚未加入資料夾";
      return;
    }
    const total = states.reduce((sum, g) => sum + g.total, 0);
    const analyzed = states.reduce((sum, g) => sum + g.analyzed, 0);
    const pending = states.reduce((sum, g) => sum + g.pending, 0);
    folderText.innerHTML = `<strong>已加入 ${states.length} 批資料｜共 ${total} 檔</strong><span>已分析 ${analyzed} 檔｜待分析 ${pending} 檔</span>`;
  }

  function readAllDirectoryEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      const readBatch = () => reader.readEntries(batch => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        readBatch();
      }, reject);
      readBatch();
    });
  }

  async function entriesFromDroppedEntry(entry, parentPath = "") {
    if (!entry) return [];
    const cleanName = String(entry.name || "").replace(/^\/+/, "");
    const currentPath = parentPath ? `${parentPath}/${cleanName}` : cleanName;
    if (entry.isFile) {
      return await new Promise(resolve => entry.file(file => resolve([{
        path: currentPath,
        filename: file.name || cleanName,
        sourceSignature: currentPath,
        dropped: true
      }]), () => resolve([])));
    }
    if (entry.isDirectory) {
      try {
        const children = await readAllDirectoryEntries(entry.createReader());
        const nested = await Promise.all(children.map(child => entriesFromDroppedEntry(child, currentPath)));
        return nested.flat();
      } catch (error) {
        console.error("production directory read failed:", error);
        return [];
      }
    }
    return [];
  }

  async function collectDroppedProductionEntries(dataTransfer) {
    const items = Array.from(dataTransfer?.items || []);
    const roots = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    if (roots.length) {
      const groups = await Promise.all(roots.map(root => entriesFromDroppedEntry(root)));
      return dedupeProductionEntries(groups.flat());
    }
    // fallback：部分瀏覽器只提供 files。
    return dedupeProductionEntries(Array.from(dataTransfer?.files || []).map(file => ({
      path: file.webkitRelativePath || file.name,
      filename: file.name,
      sourceSignature: file.webkitRelativePath || file.name,
      dropped: true
    })));
  }

  function summarizeDroppedFolders(entries) {
    const groups = new Map();
    (entries || []).forEach(entry => {
      const parts = splitPath(entry.path || entry.filename);
      const date = inferDateFromPath(parts) || "無日期";
      const process = inferProcess(parts, date) || "未指定";
      const key = `${date}|${process}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    return Array.from(groups.entries()).map(([key, count]) => {
      const [date, process] = key.split("|");
      return `${date}｜${process} ${count} 檔`;
    });
  }

  function applyFolderPriority(records) {
    const folderGroups = new Map();
    records.forEach(record => {
      if (!record.folderPriority || !record.folderName) return;
      const key = `${record.process}|${record.folderName}`;
      if (!folderGroups.has(key)) folderGroups.set(key, []);
      folderGroups.get(key).push(record);
    });

    folderGroups.forEach(group => {
      group.forEach((record, index) => {
        record.fileCountInFolder = group.length;
        if (index > 0) {
          record.countedQuantity = 0;
          record.stockDetails = [];
          record.mergedByFolder = true;
        }
      });
    });
  }

  function applySharedSideCommonMerge(records) {
    // 共用正/反面製作檔：例如 正01、正02 + 反同圖X2 => 成品 2 件。
    // 只有數量吻合時才自動合併；不一致則保留並產生解析警告。
    const groups = new Map();
    records.forEach(record => {
      const info = record.sharedSideInfo;
      if (!info || record.folderPriority) return;
      const mergeIdentity = String(record.identity || record.filename || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[\s_-]+/g, "")
        .toLowerCase();
      const key = `${record.date}|${record.process}|${record.source}|${record.product}|${mergeIdentity}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });

    groups.forEach(group => {
      const shared = group.filter(r => r.sharedSideInfo?.type === "shared");
      if (shared.length !== 1) return;
      const sharedRecord = shared[0];
      const sharedInfo = sharedRecord.sharedSideInfo;
      const oppositeRole = sharedInfo.role === "front" ? "back" : "front";
      const individuals = group.filter(r => r.sharedSideInfo?.type === "individual" && r.sharedSideInfo.role === oppositeRole);
      if (!individuals.length) return;

      const individualTotal = individuals.reduce((sum, r) => sum + Math.max(1, Number(r.quantity || 1)), 0);
      const sharedQty = Math.max(1, Number(sharedInfo.quantity || 1));
      if (individualTotal !== sharedQty) {
        const frontQty = sharedInfo.role === "front" ? sharedQty : individualTotal;
        const backQty = sharedInfo.role === "back" ? sharedQty : individualTotal;
        const warning = `正反面數量不一致：正面 ${frontQty}、反面 ${backQty}`;
        group.forEach(r => {
          r.issues = Array.from(new Set([...(r.issues || []), warning]));
          r.sharedSideGroupHandled = true;
        });
        return;
      }

      // 共用面本身不額外計數；每個獨立面維持自己的數量。
      sharedRecord.countedQuantity = 0;
      sharedRecord.stockDetails = [];
      sharedRecord.mergedByProductionAttribute = true;
      sharedRecord.sharedSideGroupHandled = true;
      sharedRecord.mergeReason = `${sharedInfo.side}同圖×${sharedQty}共用製作檔合併`;
      individuals.forEach(r => {
        r.sharedSideGroupHandled = true;
        r.mergeReason = sharedRecord.mergeReason;
      });
      group.filter(r => !r.sharedSideGroupHandled).forEach(r => { r.sharedSideGroupHandled = true; });
    });
  }

  function applyPairedPresentationFaceMerge(records) {
    // 特例：兩用名片架等製作檔會以「正面 + 旋轉面」成對出現。
    // 「正面」仍保留既有 side 屬性，避免破壞其他商品的正/背合併；
    // 這裡另外以相同 identity 判斷正面與旋轉面為同一件，只計一次。
    const groups = new Map();
    records.forEach(record => {
      if (record.folderPriority) return;
      const isFront = record.productionAttributeFamily === "side" && record.productionAttribute === "正";
      const isRotate = record.productionAttributeFamily === "presentationFace" && record.productionAttribute === "旋轉面";
      if (!isFront && !isRotate) return;
      const mergeIdentity = String(record.identity || record.filename || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[\s_-]+/g, "")
        .toLowerCase();
      const key = `${record.date}|${record.process}|${record.source}|${record.product}|${record.quantity}|${mergeIdentity}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });

    groups.forEach(group => {
      const hasFront = group.some(r => r.productionAttributeFamily === "side" && r.productionAttribute === "正");
      const hasRotate = group.some(r => r.productionAttributeFamily === "presentationFace" && r.productionAttribute === "旋轉面");
      if (!hasFront || !hasRotate) return;

      // 優先保留正面為計數檔；若沒有則保留第一筆。
      const primary = group.find(r => r.productionAttributeFamily === "side" && r.productionAttribute === "正") || group[0];
      group.forEach(record => {
        record.mergeReason = "正面/旋轉面製作檔合併";
        if (record !== primary) {
          record.countedQuantity = 0;
          record.stockDetails = [];
          record.mergedByProductionAttribute = true;
        }
      });
    });
  }

  function applyProductionAttributeMerge(records) {
    const groups = new Map();
    records.forEach(record => {
      if (!record.productionAttribute || !record.productionAttributeFamily || record.folderPriority || record.sharedSideGroupHandled) return;
      const mergeIdentity = String(record.identity || record.filename || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[\s_-]+/g, "")
        .toLowerCase();
      const key = `${record.date}|${record.process}|${record.source}|${record.product}|${record.quantity}|${mergeIdentity}|${record.productionAttributeFamily}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });

    groups.forEach(group => {
      const attrs = new Set(group.map(r => r.productionAttribute));
      const family = group[0]?.productionAttributeFamily || "";
      const canMerge =
        (family === "side" && attrs.size >= 2) ||
        (family === "printLayer" && attrs.size >= 2) ||
        (family === "insideOutside" && attrs.size >= 2) ||
        (family === "engraving" && attrs.size >= 2);

      if (group.length >= 2 && canMerge) {
        const attrList = Array.from(attrs).sort().join("/");
        const reason = `${attrList}製作檔合併`;
        group.forEach((record, index) => {
          record.mergeReason = reason;
          if (index > 0) {
            record.countedQuantity = 0;
            record.stockDetails = [];
            record.mergedByProductionAttribute = true;
            if (family === "side") record.mergedBySide = true;
          }
        });
      }
    });
  }

  function applySideMerge(records) {
    applySharedSideCommonMerge(records);
    applyPairedPresentationFaceMerge(records);
    applyProductionAttributeMerge(records);
  }

  function splitStockItemName(item) {
    const value = String(item || "").trim();
    const m = value.match(/^(.+)[（(]([^()（）]+)[）)]$/);
    if (!m) return { base: value, variant: "" };
    const base = m[1].trim();
    const variant = m[2].trim();
    if (KNOWN_COLORS.includes(variant) || /[-－]/.test(variant)) return { base, variant };
    return { base: value, variant: "" };
  }

  function effectiveRecordIssues(record) {
    const list = Array.isArray(record?.issues) ? record.issues : [];
    if (!list.length) return [];

    // 「分析結果」處理的是庫存對應；「解析警告」只保留仍未解決的檔名解析問題。
    // 若使用者已經替未解析商品指定完成庫存，原本的「缺少/無法判斷商品」就視為已解決，
    // 不應在下方再要求處理一次。其他像未知標記、數量格式等警告仍保留。
    const mappingState = recordInventoryMapping(record, record.product || '');
    const mappingResolved = isStatsOnlyRecord(record, record.product || '') ||
      (mappingState.details.length > 0 && mappingState.unmapped.length === 0);

    return list.filter(issue => {
      if (mappingResolved && /缺少商品名稱|無法判斷商品名稱|無法判斷商品|未解析商品/.test(issue)) return false;
      return true;
    });
  }

  function summarize(records) {
    const product = new Map();
    const source = new Map();
    const tag = new Map();
    const process = new Map();
    const issues = [];

    const add = (map, key, qty) => map.set(key, (map.get(key) || 0) + qty);
    const addProduct = (item, unit, qty) => {
      const parsed = splitStockItemName(item);
      const key = `${parsed.base}||${unit || "件"}`;
      if (!product.has(key)) product.set(key, { name: parsed.base, unit: unit || "件", quantity: 0, variants: new Map() });
      const row = product.get(key);
      row.quantity += qty;
      if (parsed.variant) row.variants.set(parsed.variant, (row.variants.get(parsed.variant) || 0) + qty);
    };

    records.forEach(record => {
      const qty = record.countedQuantity || 0;
      if (qty > 0) {
        const stockDetails = (record.stockDetails || []).filter(d => Number(d.quantity || 0) > 0);
        if (stockDetails.length) {
          stockDetails.forEach(detail => addProduct(detail.item, detail.unit || record.unit, Number(detail.quantity || 0)));
        } else {
          addProduct(record.product, record.unit, qty);
        }
        add(source, record.source || "未標示", qty);
        add(process, record.process || "未指定", qty);
        if (record.tags.length) record.tags.forEach(t => add(tag, t, qty));
      }
      const visibleIssues = effectiveRecordIssues(record);
      if (visibleIssues.length) issues.push({ ...record, issues: visibleIssues });
    });

    const productRows = Array.from(product.values()).map(row => ({
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      variants: Array.from(row.variants.entries()).map(([name, quantity]) => ({ name, quantity })).sort((a,b)=>b.quantity-a.quantity || a.name.localeCompare(b.name,"zh-Hant"))
    })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "zh-Hant"));

    const mapRows = map => Array.from(map.entries()).map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "zh-Hant"));

    return {
      productRows,
      sourceRows: mapRows(source),
      tagRows: mapRows(tag),
      processRows: mapRows(process),
      issues
    };
  }

  function filterEntriesByMode(entries, mode, dateValue, startDate, endDate) {
    if (mode === "all") return entries;
    return entries.filter(entry => {
      const pathParts = splitPath(entry.path || entry.filename);
      const inferred = inferDateFromPath(pathParts);
      if (!inferred) return true;
      if (mode === "range") return isDateInRange(inferred, startDate, endDate);
      return inferred === dateValue;
    });
  }

  function analyze(entries, dateValue) {
    const records = entries.map(entry => parseEntry(entry, dateValue));
    applyFolderPriority(records);
    applySideMerge(records);
    return {
      date: dateValue,
      records,
      summary: summarize(records)
    };
  }


  function aggregateAnalysisFromRecords(records, label) {
    return {
      date: label || "目前工作階段",
      records,
      summary: summarize(records)
    };
  }

  function productQuantityMap(productRows = []) {
    return new Map((productRows || []).map(row => [row.name, Number(row.quantity || 0)]));
  }

  function calculateProductChanges(previousRows = [], nextRows = []) {
    const previous = productQuantityMap(previousRows);
    const changes = new Map();
    (nextRows || []).forEach(row => {
      const before = previous.get(row.name);
      const after = Number(row.quantity || 0);
      if (before === undefined) changes.set(row.name, { type: "new", delta: after });
      else if (before !== after) changes.set(row.name, { type: "updated", delta: after - before });
    });
    return changes;
  }

  function captureAnalysisChange(previousRows, analysis) {
    lastProductChanges = calculateProductChanges(previousRows || [], analysis?.summary?.productRows || []);
  }

  function recordSessionKey(record) {
    return `${record.date || "無日期"}|${record.process || "未指定"}`;
  }

  function inferSessionLabel(records, fallback) {
    const dates = Array.from(new Set(records.map(r => r.date).filter(Boolean))).sort();
    if (!dates.length) return fallback || "目前工作階段";
    if (dates.length === 1) return dates[0];
    return `${dates[0]} ~ ${dates[dates.length - 1]}`;
  }

  function addAnalysisToSession(analysis) {
    const incomingKeys = new Set(analysis.records.map(recordSessionKey));
    const incomingFileFingerprints = new Set(analysis.records.map(r => `${r.date || "無日期"}|${r.sourceSignature || r.filename}`));
    const incomingNames = new Set(analysis.records.map(r => `${r.date || "無日期"}|${r.filename}`));
    const incomingHasNamedProcess = analysis.records.some(r => r.process && r.process !== "未指定");
    // 不同製程 / 不同資料夾要累加到目前工作階段。
    // 只有「同一日期＋同一製程」重新分析，或同一批檔案由未指定補上製程時，才覆蓋舊資料。
    currentSession.records = currentSession.records.filter(r => {
      const keyHit = incomingKeys.has(recordSessionKey(r));
      const sameFileHit = incomingFileFingerprints.has(`${r.date || "無日期"}|${r.sourceSignature || r.filename}`);
      const unnamedSameFileHit = incomingNames.has(`${r.date || "無日期"}|${r.filename}`) && r.process === "未指定" && incomingHasNamedProcess;
      return !(keyHit || sameFileHit || unnamedSameFileHit);
    });
    currentSession.records.push(...analysis.records);
    currentSession.label = inferSessionLabel(currentSession.records, analysis.date);
    currentSession.updatedAt = new Date().toLocaleString("zh-TW", { hour12: false });
    const sessionKeys = new Set(currentSession.records.map(recordSessionKey));
    currentSession.sources = Array.from(sessionKeys).map(key => {
      const [date, process] = key.split("|");
      const count = currentSession.records.filter(r => recordSessionKey(r) === key).length;
      return { key, date, process, count, updatedAt: currentSession.updatedAt };
    });
    currentSession.sources.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.process || "").localeCompare(b.process || "", "zh-Hant"));
    return aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
  }

  function renderSessionPanel() {
    const labelEl = $("productionSessionLabel");
    const listEl = $("productionSessionList");
    const states = droppedFolderStates();
    const analyzedCount = states.reduce((sum, g) => sum + g.analyzed, 0);
    const pendingCount = states.reduce((sum, g) => sum + g.pending, 0);
    const pendingBatches = states.filter(g => g.pending > 0);
    const analyzedBatches = states.filter(g => g.pending === 0);
    if (labelEl) {
      if (states.length) labelEl.textContent = `${states.length} 批｜待分析 ${pendingBatches.length} 批・${pendingCount} 檔｜已分析 ${analyzedBatches.length} 批・${analyzedCount} 檔`;
      else labelEl.textContent = currentSession.label || "尚未建立";
    }
    const analyzeBtn = $("productionAnalyzeBtn");
    if (analyzeBtn) {
      analyzeBtn.disabled = pendingCount <= 0;
      analyzeBtn.textContent = pendingCount > 0 ? `分析新增資料（${pendingCount} 檔）` : "✓ 全部分析完成";
    }
    if (!listEl) return;

    if (states.length) {
      const rowHtml = source => {
        const isDone = source.pending === 0;
        const isPartial = source.analyzed > 0 && source.pending > 0;
        const batchEntries = droppedProductionEntries.filter(entry => productionBatchInfo(entry).key === source.key);
        const batchKeys = batchEntries.map(productionEntryKey);
        const activeKeys = activeProductionSourceKeys();
        const isDeducted = isDone && batchKeys.length > 0 && batchKeys.every(key => activeKeys.has(key));
        const statusText = isDeducted ? "✓ 已完成・已扣庫存" : (isDone ? "✓ 已分析・待扣庫存" : (isPartial ? "● 有新增待分析" : "● 待分析"));
        const countText = isDone ? `${source.total} 檔` : (isPartial ? `${source.analyzed} 已分析＋${source.pending} 待分析` : `${source.pending} 檔待分析`);
        const dup = source.duplicateAttempts ? `<span class="production-session-duplicate">重複加入 ${source.duplicateAttempts} 檔・已略過</span>` : "";
        return `
          <div class="production-session-item ${isDone ? "is-analyzed" : "is-pending"}" data-key="${escapeHtml(source.key)}">
            <span class="production-session-main"><b class="production-session-status">${statusText}</b><span class="production-session-folder"><strong>${escapeHtml(source.folder)}</strong><small>${escapeHtml(source.date)}｜${escapeHtml(source.process)}</small>${dup}</span></span>
            <span class="production-session-actions"><strong>${escapeHtml(countText)}</strong></span>
          </div>`;
      };
      const pendingHtml = pendingBatches.length ? `<div class="production-session-group"><div class="production-session-group-title"><strong>等待分析</strong><span>${pendingBatches.length} 批｜${pendingCount} 檔</span></div>${pendingBatches.map(rowHtml).join("")}</div>` : `<div class="production-session-empty-state is-done">✓ 目前沒有等待分析的資料</div>`;
      const analyzedHtml = analyzedBatches.length ? `<details class="production-session-completed" ${pendingBatches.length ? "" : "open"}><summary><strong>已分析</strong><span>${analyzedBatches.length} 批｜${analyzedCount} 檔</span></summary>${analyzedBatches.map(rowHtml).join("")}</details>` : "";
      listEl.innerHTML = pendingHtml + analyzedHtml + `<div class="production-session-footnote">扣庫存完成後批次仍會保留；測試期間可使用「復原此次扣庫存」將數量加回。</div>`;
      return;
    }

    if (!currentSession.sources.length) {
      listEl.innerHTML = "加入資料夾後，這裡會列出每個資料夾的名稱、待分析／已分析狀態與重複加入提示。";
      return;
    }
    listEl.innerHTML = currentSession.sources.map(source => `
      <div class="production-session-item is-analyzed" data-key="${escapeHtml(source.key)}">
        <span class="production-session-main"><b class="production-session-status">${currentSession.records.filter(r => recordSessionKey(r) === source.key).every(r => Number(r.countedQuantity || 0) <= 0 || isStatsOnlyRecord(r) || recordHasActiveDeduction(r)) ? "✓ 已完成・已扣庫存" : "✓ 已分析・待扣庫存"}</b><span>${escapeHtml(source.date)}｜<strong>${escapeHtml(source.process)}</strong></span></span>
        <span class="production-session-actions"><strong>${escapeHtml(source.count)} 檔</strong></span>
      </div>
    `).join("");
  }

  function updateProductionStatus(message, type = "idle") {
    const el = $("productionStatusBox");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("is-running", "is-done");
    if (type === "running") el.classList.add("is-running");
    if (type === "done") el.classList.add("is-done");
  }

  function resetSession() {
    currentSession = createEmptySession();
    lastAnalysis = null;
    lastProductChanges = new Map();
    renderSessionPanel();
    $("productionSummaryCards").innerHTML = '<div class="production-summary-empty">尚未分析</div>';
    ["productionProductResult", "productionSourceResult", "productionTagResult", "productionProcessResult", "productionDetailResult", "productionIssueActionResult", "productionIssueInfoResult"].forEach(id => {
      const el = $(id);
      if (el) el.textContent = "尚未分析";
    });
    const exportBtn = $("productionExportCsvBtn");
    if (exportBtn) exportBtn.disabled = true;
    setProductionFlowState(null);
    renderDeductPreview(null);
    updateProductionStatus("目前畫面已清空；此版本只清除瀏覽器畫面，沒有寫入庫存，也沒有雲端留存。", "idle");
  }

  function renderSummary(analysis) {
    const totalFiles = analysis.records.length;
    const totalQty = analysis.records.reduce((sum, r) => sum + (r.countedQuantity || 0), 0);
    const products = analysis.summary.productRows.length;
    const issues = actionableIssues(analysis).length;
    const infoIssues = informationalIssues(analysis).length;
    $("productionSummaryCards").innerHTML = [
      ["掃描檔案", totalFiles],
      ["計算數量", totalQty],
      ["商品種類", products],
      ["需處理警告", issues + (infoIssues ? `｜提示 ${infoIssues}` : "")]
    ].map(([label, value]) => `<div class="production-summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  }

  function renderSimpleTable(el, rows, columns, emptyText) {
    if (!rows.length) {
      el.innerHTML = `<p>${escapeHtml(emptyText || "沒有資料")}</p>`;
      return;
    }
    el.innerHTML = `<table class="production-table"><thead><tr>${columns.map(c => `<th class="${c.num ? "num" : ""}">${escapeHtml(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr class="${escapeHtml(row._rowClass || "")}">${columns.map(c => {
      const value = c.render ? c.render(row) : row[c.key];
      const content = c.html ? (value || "") : escapeHtml(value);
      return `<td class="${c.num ? "num" : ""}">${content}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function recordContributesToProduct(record, productName) {
    if (!record || !productName) return false;
    if (record.product === productName) return true;
    return (record.stockDetails || []).some(d => d.item === productName || splitStockItemName(d.item).base === productName);
  }

  function productQuantityFromRecord(record, productName) {
    const details = (record.stockDetails || []).filter(d => d.item === productName || splitStockItemName(d.item).base === productName);
    if (details.length) return details.reduce((sum, d) => sum + Number(d.quantity || 0), 0);
    return record.product === productName ? Number(record.countedQuantity || 0) : 0;
  }

  function productVariantFromRecord(record, productName) {
    const details = (record.stockDetails || []).filter(d => d.item === productName || splitStockItemName(d.item).base === productName);
    const vars = details.map(d => d.variant || splitStockItemName(d.item).variant).filter(Boolean);
    return Array.from(new Set(vars)).join("、");
  }

  function normalizeInventoryName(value) {
    return String(value || "")
      .trim()
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function inventoryNameMap() {
    const map = new Map();
    getInventoryProductOptions().forEach(name => {
      const key = normalizeInventoryName(name);
      if (key && !map.has(key)) map.set(key, name);
    });
    return map;
  }

  function isStatsOnlyRecord(record, productName = "") {
    if (!record) return false;
    if (record.statsOnly) return true;
    const names = [productName, record.originalParsedProduct, record.originalProduct, record.product].filter(Boolean);
    return names.some(name => !!runtimeRules.statsOnlyProducts?.[name]);
  }

  function setStatsOnlyForRecord(record, permanent = false, batch = false) {
    if (!record) return;
    const originalName = record.originalParsedProduct || record.originalProduct || record.product || "";
    const targets = batch ? similarRecords(record) : [record];
    targets.forEach(r => {
      r.statsOnly = true;
      r.stockDetails = [];
      r.manualNote = "僅統計，不扣庫存";
    });
    if (permanent && originalName) {
      runtimeRules.statsOnlyProducts = { ...(runtimeRules.statsOnlyProducts || {}), [originalName]: true };
      saveRuntimeRules();
    }
  }

  function similarRecordKey(record) {
    const raw = String(record?.originalParsedProduct || record?.product || record?.filename || "")
      .replace(/\.[^.]+$/, "")
      .replace(/(?:資料組|順序|未命名)[ _-]*\d+/gi, m => m.replace(/\d+/g, "#"))
      .replace(/(?:^|[_ -])\d{1,3}(?=$|[_ -])/g, " #")
      .replace(/\s+/g, "")
      .toLowerCase();
    return raw || String(record?.product || "").toLowerCase();
  }

  function similarRecords(record) {
    const key = similarRecordKey(record);
    return currentSession.records.filter(r => similarRecordKey(r) === key && Number(r.countedQuantity || r.quantity || 0) > 0);
  }

  function recordInventoryMapping(record, productName) {
    const inv = inventoryNameMap();
    // V3.46：庫存對應狀態必須讀取「實際會拿去扣庫存的 stockDetails」。
    // 舊版會用商品名稱再次篩選 detail，像「黃銅門牌 → 黃銅片＋木底座」這種跨品項對應
    // 會被誤判成尚未對應，但 buildDeductionPlan 又能正常扣，造成上下畫面互相矛盾。
    const rawDetails = (record?.stockDetails || []).filter(d => Number(d.quantity || 0) > 0 && String(d.item || "").trim());
    const details = rawDetails.length
      ? rawDetails
      : (record?.product === productName && Number(record?.countedQuantity || 0) > 0
        ? [{ item: record.product, quantity: record.countedQuantity, unit: record.unit || "件", note: "解析商品" }]
        : []);
    const mapped = [];
    const unmapped = [];
    details.forEach(detail => {
      const official = inv.get(normalizeInventoryName(detail.item));
      const row = { ...detail, officialName: official || "" };
      if (official) mapped.push(row);
      else unmapped.push(row);
    });
    return { mapped, unmapped, details };
  }

  function productInventoryMappingStatus(productName) {
    const rows = (lastAnalysis?.records || []).filter(r => Number(r.countedQuantity || 0) > 0 && recordContributesToProduct(r, productName));
    if (rows.length && rows.every(r => isStatsOnlyRecord(r, productName))) {
      return { status: "stats", mappedNames: [], mappedTargets: [], unmappedNames: [], mappedCount: 0, unmappedCount: 0 };
    }

    const allMapped = [];
    const allUnmapped = [];
    rows.filter(r => !isStatsOnlyRecord(r, productName)).forEach(record => {
      const state = recordInventoryMapping(record, productName);
      allMapped.push(...state.mapped);
      allUnmapped.push(...state.unmapped);
    });

    const unique = values => Array.from(new Set(values.filter(Boolean)));
    const mappedNames = unique(allMapped.map(d => d.officialName || d.item));
    const unmappedNames = unique(allUnmapped.map(d => d.item));
    const targetTotals = new Map();
    allMapped.forEach(detail => {
      const name = detail.officialName || detail.item;
      const qty = Math.max(0, Math.round(Number(detail.quantity || 0)));
      if (!name || !qty) return;
      targetTotals.set(name, (targetTotals.get(name) || 0) + qty);
    });
    const mappedTargets = Array.from(targetTotals, ([name, quantity]) => ({ name, quantity }));
    const status = allUnmapped.length === 0 && allMapped.length > 0 ? "mapped" : allMapped.length > 0 ? "partial" : "unmapped";
    return { status, mappedNames, mappedTargets, unmappedNames, mappedCount: allMapped.length, unmappedCount: allUnmapped.length };
  }

  function mappingStatusHtml(productName) {
    const state = productInventoryMappingStatus(productName);
    if (state.status === "stats") {
      return `<span class="production-map-badge is-mapped">◎ 僅統計</span><div class="production-map-target">不參與庫存扣減</div>`;
    }
    if (state.status === "mapped") {
      const targets = (state.mappedTargets || []).map(row => `${row.name} −${row.quantity}`).join("、");
      return `<span class="production-map-badge is-mapped">✓ 已對應</span>${targets ? `<div class="production-map-target production-map-deduct-target"><span>準備扣：</span>${escapeHtml(targets)}</div>` : ""}`;
    }
    if (state.status === "partial") {
      const targets = (state.mappedTargets || []).map(row => `${row.name} −${row.quantity}`).join("、");
      return `<span class="production-map-badge is-partial">⚠ 部分對應</span>${targets ? `<div class="production-map-target production-map-deduct-target"><span>已納入：</span>${escapeHtml(targets)}</div>` : ""}<div class="production-map-target">待處理：${escapeHtml(state.unmappedNames.join("、") || "尚有未對應品項")}</div>`;
    }
    return `<span class="production-map-badge is-unmapped">⚠ 尚未對應</span>${state.unmappedNames.length ? `<div class="production-map-target">解析：${escapeHtml(state.unmappedNames.join("、"))}</div>` : ""}`;
  }

  function buildProductDetailHtml(productName) {
    if (!lastAnalysis || !productName) {
      return `<div class="production-side-empty">點選商品名稱即可查看計入此商品的檔案。</div>`;
    }
    const rows = lastAnalysis.records.filter(record => recordContributesToProduct(record, productName));
    if (!rows.length) {
      return `<div class="production-side-empty">目前沒有找到「${escapeHtml(productName)}」的來源明細。</div>`;
    }
    const total = rows.reduce((sum, r) => sum + productQuantityFromRecord(r, productName), 0);
    const countedFiles = rows.filter(r => productQuantityFromRecord(r, productName) > 0).length;
    const mergedFiles = rows.length - countedFiles;
    return `
      <div class="production-side-head production-inline-source-head">
        <div>
          <div class="production-side-label">計入來源檔案</div>
          <h4>${escapeHtml(productName)}</h4>
          <div class="production-inline-source-summary">${escapeHtml(rows.length)} 個檔案｜實際計入 ${escapeHtml(countedFiles)} 個${mergedFiles > 0 ? `｜合併 ${escapeHtml(mergedFiles)} 個` : ""}</div>
        </div>
        <strong>${escapeHtml(total)} 件</strong>
      </div>
      <div class="production-side-list production-inline-source-list">
        ${rows.map(r => {
          const qty = productQuantityFromRecord(r, productName);
          const isCounted = qty > 0;
          const mergeText = r.mergeReason || (r.mergedByFolder ? "資料夾優先合併" : "");
          const mapState = recordInventoryMapping(r, productName);
          const mapped = mapState.mapped.map(d => d.officialName || d.item);
          const unmapped = mapState.unmapped.map(d => d.item);
          const mapHtml = isStatsOnlyRecord(r, productName)
            ? `<span class="production-inline-file-map is-stats">僅統計</span>`
            : (!mapState.details.length || unmapped.length)
              ? `<span class="production-inline-file-map is-warning">需確認庫存對應</span>`
              : `<span class="production-inline-file-map is-ok">${escapeHtml(Array.from(new Set(mapped)).join("、"))}</span>`;
          return `
            <div class="production-side-item production-inline-source-item ${isCounted ? "is-counted" : "is-merged"}">
              <div class="production-inline-source-main">
                <div class="production-inline-source-status">
                  <span class="production-file-count-badge ${isCounted ? "is-counted" : "is-merged"}">${isCounted ? `計入 ${escapeHtml(qty)}` : "已合併・不重複計數"}</span>
                  ${mapHtml}
                </div>
                <div class="production-side-file">${escapeHtml(r.filename)}</div>
                <div class="production-side-meta">${escapeHtml(productVariantFromRecord(r, productName) ? `規格：${productVariantFromRecord(r, productName)}｜` : "")}${escapeHtml(r.source || "")}｜${escapeHtml(r.process || "")}${mergeText ? `｜${escapeHtml(mergeText)}` : ""}</div>
              </div>
              <div class="production-inline-source-actions">
                ${isCounted && !isStatsOnlyRecord(r, productName) ? `<button type="button" class="secondary small production-record-product-btn" data-path="${escapeHtml(r.path)}" data-file="${escapeHtml(r.filename)}">修改對應</button>` : ""}
                <button type="button" class="secondary small danger-text production-record-remove-btn" data-key="${escapeHtml(r.path || r.filename)}">移除</button>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  function renderProductDetailPanel(productName) {
    const el = $("productionProductDetailPanel");
    if (!el) return;
    el.innerHTML = buildProductDetailHtml(productName);
  }

  function renderInlineProductDetail(productName) {
    const result = $("productionProductResult");
    if (!result) return;
    result.querySelectorAll(".production-product-inline-detail-row").forEach(row => row.remove());
    if (!productName) return;
    const button = Array.from(result.querySelectorAll(".production-product-select-btn"))
      .find(btn => btn.dataset.product === productName);
    const row = button?.closest("tr");
    if (!row) return;
    row.classList.add("is-detail-open");
    const detailRow = document.createElement("tr");
    detailRow.className = "production-product-inline-detail-row";
    detailRow.innerHTML = `<td colspan="5"><div class="production-product-inline-detail-box">${buildProductDetailHtml(productName)}</div></td>`;
    row.insertAdjacentElement("afterend", detailRow);
  }

  function isInformationalIssueText(issueText) {
    return /舊式尾端數量/.test(String(issueText || ""));
  }

  function issueSeverity(record) {
    const issueText = (record?.issues || []).join("；");
    return isInformationalIssueText(issueText) ? "info" : "action";
  }

  function actionableIssues(analysis) {
    return (analysis?.summary?.issues || []).filter(record => issueSeverity(record) === "action");
  }

  function informationalIssues(analysis) {
    return (analysis?.summary?.issues || []).filter(record => issueSeverity(record) === "info");
  }

  function reviewSuggestion(record) {
    const issueText = (record.issues || []).join("；");
    if (/舊式尾端數量/.test(issueText)) return "✓ 已計入，不需操作；若方便，未來可改成 (x數量)";
    if (/數量格式/.test(issueText)) return "請修正 (x數量)，例如 (x20)";
    if (/缺少商品|無法判斷商品/.test(issueText)) return "可按『指定商品』補上本次商品名稱";
    if (/未知開頭標記/.test(issueText)) return "可直接加入標籤、來源或忽略";
    return "確認是否需要新增規則";
  }

  function renderIssueActions(record) {
    const issueText = (record.issues || []).join("；");
    const token = (record.unknownStartTokens || [])[0] || "";
    const buttons = [];
    if (token) {
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="token-tag" data-token="${escapeHtml(token)}" data-file="${escapeHtml(record.filename)}">加入標籤</button>`);
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="token-source" data-token="${escapeHtml(token)}" data-file="${escapeHtml(record.filename)}">加入來源</button>`);
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="token-ignore" data-token="${escapeHtml(token)}" data-file="${escapeHtml(record.filename)}">本次略過標記（仍計入商品）</button>`);
    }
    if (/缺少商品|無法判斷商品/.test(issueText) || record.product === "未解析") {
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="manual-product" data-file="${escapeHtml(record.filename)}">指定商品</button>`);
    }
    if (/舊式尾端數量/.test(issueText)) {
      buttons.push(`<span class="production-info-no-action">已計入，不需操作</span>`);
    }
    return buttons.join(" ") || "請依建議修正檔名後重新分析";
  }

  function setProductionFlowState(analysis) {
    const analyzeStep = document.querySelector('.production-flow-step[data-step="analyze"]');
    const reviewStep = document.querySelector('.production-flow-step[data-step="review"]');
    const deductStep = document.querySelector('.production-flow-step[data-step="deduct"]');
    [analyzeStep, reviewStep, deductStep].forEach(el => el?.classList.remove('is-active','is-done'));
    const simpleSteps = document.querySelectorAll('.production-simple-steps span');
    simpleSteps.forEach(el => el.classList.remove('is-active','is-done'));
    if (!analysis || !analysis.records?.length) { analyzeStep?.classList.add('is-active'); simpleSteps[0]?.classList.add('is-active'); return; }
    analyzeStep?.classList.add('is-done');
    simpleSteps[0]?.classList.add('is-done');
    const hasIssues = actionableIssues(analysis).length > 0;
    const hasUnmapped = (analysis.summary?.productRows || []).some(row => !["mapped","stats"].includes(productInventoryMappingStatus(row.name).status));
    if (hasIssues || hasUnmapped) { reviewStep?.classList.add('is-active'); simpleSteps[1]?.classList.add('is-active'); }
    else { reviewStep?.classList.add('is-done'); deductStep?.classList.add('is-active'); simpleSteps[1]?.classList.add('is-done'); simpleSteps[2]?.classList.add('is-active'); }
  }

  function getProductionTransactions() {
    try {
      if (typeof data === "undefined") return [];
      data.productionTransactions = Array.isArray(data.productionTransactions) ? data.productionTransactions : [];
      return data.productionTransactions;
    } catch (error) {
      return [];
    }
  }

  function activeProductionSourceKeys() {
    const keys = new Set();
    getProductionTransactions().filter(tx => tx && tx.status === "active").forEach(tx => {
      (tx.sourceKeys || []).forEach(key => keys.add(String(key || "")));
    });
    return keys;
  }

  function currentUserLabelForProduction() {
    try { if (typeof getCurrentUserLabel === "function") return getCurrentUserLabel(); } catch (error) {}
    return window.GB_AUTH?.user?.displayName || window.GB_AUTH?.user?.email || "使用者";
  }

  function currentUserEmailForProduction() {
    try { if (typeof getCurrentUserEmail === "function") return getCurrentUserEmail(); } catch (error) {}
    return window.GB_AUTH?.user?.email || "";
  }

  function officialInventoryItem(name) {
    const key = normalizeInventoryName(name);
    try {
      if (typeof data !== "undefined" && Array.isArray(data.items)) {
        return data.items.find(item => !item.disabled && normalizeInventoryName(item.name) === key) || null;
      }
    } catch (error) {}
    return null;
  }

  function buildDeductionPlan(analysis) {
    const totals = new Map();
    const sourceKeys = new Set();
    const duplicateSourceKeys = new Set();
    const alreadyDeducted = activeProductionSourceKeys();
    const unmapped = [];

    (analysis?.records || []).forEach(record => {
      if (Number(record.countedQuantity || 0) <= 0 || isStatsOnlyRecord(record)) return;
      // V3.44：同一工作階段可連續分析多個資料夾。
      // 已完成扣庫存的舊紀錄不再加入下一次扣除計畫；若是重新加入同一來源檔，
      // 但沒有本工作階段的交易標記，仍會由 activeProductionSourceKeys 擋重複扣除。
      if (recordHasActiveDeduction(record)) return;
      const sourceKey = String(record.sourceSignature || record.path || record.filename || "");
      if (sourceKey) {
        sourceKeys.add(sourceKey);
        if (alreadyDeducted.has(sourceKey)) duplicateSourceKeys.add(sourceKey);
      }
      const details = (record.stockDetails || []).filter(d => Number(d.quantity || 0) > 0);
      details.forEach(detail => {
        const item = officialInventoryItem(detail.item);
        if (!item) {
          unmapped.push(detail.item);
          return;
        }
        const qty = Math.max(0, Math.round(Number(detail.quantity || 0)));
        if (!qty) return;
        if (!totals.has(item.id)) totals.set(item.id, { item, quantity: 0, sourceFiles: 0 });
        const row = totals.get(item.id);
        row.quantity += qty;
        row.sourceFiles += 1;
      });
    });

    const rows = Array.from(totals.values()).map(row => ({
      ...row,
      stock: Number(row.item.stock || 0),
      after: Number(row.item.stock || 0) - row.quantity,
      insufficient: Number(row.item.stock || 0) < row.quantity
    })).sort((a,b) => a.item.name.localeCompare(b.item.name, "zh-Hant"));

    return {
      rows,
      sourceKeys: Array.from(sourceKeys),
      duplicateSourceKeys: Array.from(duplicateSourceKeys),
      unmapped: Array.from(new Set(unmapped.filter(Boolean))),
      insufficient: rows.filter(row => row.insufficient)
    };
  }

  function findProductionTransaction(id) {
    return getProductionTransactions().find(tx => tx.id === id) || null;
  }

  function recordHasActiveDeduction(record) {
    const txId = String(record?.deductedTransactionId || "");
    if (!txId) return false;
    return findProductionTransaction(txId)?.status === "active";
  }

  function latestProductionTransaction() {
    const txs = getProductionTransactions();
    if (lastProductionTransactionId) {
      const tx = txs.find(row => row.id === lastProductionTransactionId);
      if (tx) return tx;
    }
    return txs.find(tx => tx.status === "active" || tx.status === "reverted") || null;
  }

  function recentProductionTransactions(limit = 10) {
    return getProductionTransactions()
      .filter(tx => tx && (tx.status === "active" || tx.status === "reverted"))
      .slice(0, limit);
  }

  function renderProductionTransactionStatus() {
    const box = $("productionDeductTransaction");
    if (!box) return;
    const txs = recentProductionTransactions(10);
    if (!txs.length) {
      box.className = "production-transaction-status hidden";
      box.innerHTML = "";
      return;
    }

    const compactOnMobile = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
    const cards = txs.map((tx, index) => {
      const txItems = Array.isArray(tx.items) ? tx.items : [];
      const totalQty = txItems.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
      const folderNames = Array.isArray(tx.folders) ? tx.folders.filter(Boolean) : [];
      const folderText = folderNames.length ? `${folderNames.length} 個資料夾` : `${(tx.sourceKeys || []).length} 個來源檔`;
      const itemRows = txItems.map(row => `
        <div class="production-transaction-item-row">
          <span class="production-transaction-item-name">${escapeHtml(row.itemName || "未命名品項")}</span>
          <strong class="production-transaction-item-qty">−${escapeHtml(Number(row.quantity) || 0)}</strong>
        </div>`).join("");
      const reverted = tx.status === "reverted";
      const shouldOpen = !compactOnMobile && index === 0;
      return `
        <details class="production-transaction-card ${reverted ? "is-reverted" : "is-active"}" data-transaction-id="${escapeHtml(tx.id)}" ${shouldOpen ? "open" : ""}>
          <summary class="production-transaction-summary-row">
            <div class="production-transaction-head">
              <div class="production-transaction-heading">
                <span class="production-transaction-check" aria-hidden="true">${reverted ? "↩" : "✓"}</span>
                <div>
                  <strong class="production-transaction-title">${reverted ? "此筆扣庫存已復原" : "扣庫存完成"}</strong>
                  <span class="production-transaction-time">${escapeHtml(reverted ? (tx.revertedAtText || tx.createdAtText || "") : (tx.createdAtText || ""))}</span>
                </div>
              </div>
              <div class="production-transaction-metrics">
                <div class="production-transaction-metric"><span>本次上傳</span><strong>${escapeHtml(folderText)}</strong></div>
                <div class="production-transaction-metric"><span>庫存品項</span><strong>${txItems.length}</strong></div>
                <div class="production-transaction-metric"><span>共扣除</span><strong>${totalQty}<small> 件</small></strong></div>
              </div>
              <span class="production-transaction-toggle" aria-hidden="true"><span class="when-closed">展開</span><span class="when-open">收合</span><b>⌄</b></span>
            </div>
          </summary>
          <div class="production-transaction-body">
            <div class="production-transaction-divider"></div>
            <div class="production-transaction-items">${itemRows}</div>
            ${reverted ? "" : `
              <div class="production-transaction-actions">
                <span class="production-transaction-action-note">每一次確認扣庫存都是獨立交易，可單獨復原。</span>
                <button type="button" class="secondary production-undo-deduct-btn" data-transaction-id="${escapeHtml(tx.id)}">復原此筆扣庫存</button>
              </div>`}
          </div>
        </details>`;
    }).join("");

    box.className = "production-transaction-status production-transaction-history";
    box.innerHTML = `
      <div class="production-transaction-history-head">
        <strong>最近扣庫存紀錄</strong>
        <span>每按一次「確認扣庫存」會建立一筆獨立紀錄</span>
      </div>
      <div class="production-transaction-history-list">${cards}</div>`;

    box.querySelectorAll(".production-undo-deduct-btn").forEach(button => {
      button.addEventListener("click", () => undoProductionDeduction(button.dataset.transactionId));
    });
  }

  function renderDeductPreview(analysis) {
    const box = $('productionDeductPreview');
    const totals = $('productionDeductTotals');
    const badge = $('productionDeductReadyBadge');
    const button = $('productionConfirmDeductBtn');
    if (!box || !totals || !badge) return;
    const rows = analysis?.summary?.productRows || [];
    if (!rows.length) {
      box.className = 'production-deduct-preview-empty';
      box.textContent = '完成分析後會顯示預計扣除的庫存品項。';
      totals.textContent = '';
      badge.className = 'production-preview-badge is-idle';
      badge.textContent = '尚未分析';
      if (button) { button.disabled = true; button.textContent = '確認扣庫存'; }
      renderProductionTransactionStatus();
      return;
    }

    const issueCount = actionableIssues(analysis).length;
    const unmappedProducts = rows.filter(row => !["mapped","stats"].includes(productInventoryMappingStatus(row.name).status)).length;
    const plan = buildDeductionPlan(analysis);
    const existingTx = latestProductionTransaction();

    const deductFooter = button?.closest('.production-deduct-footer');
    // V3.44：只有「目前沒有新的待扣資料」時才顯示上一筆完成狀態並隱藏確認區。
    // 若使用者又分析了第二個資料夾，直接顯示新資料的扣庫存預覽。
    if (existingTx?.status === "active" && !plan.rows.length && !plan.unmapped.length && !plan.duplicateSourceKeys.length) {
      box.className = 'production-deduct-preview-empty hidden';
      box.innerHTML = '';
      totals.textContent = '';
      if (deductFooter) deductFooter.classList.add('hidden');
      badge.className = 'production-preview-badge is-ready';
      badge.textContent = '✓ 扣庫存完成';
      renderProductionTransactionStatus();
      return;
    }
    if (deductFooter) deductFooter.classList.remove('hidden');
    box.className = 'production-deduct-list';
    if (!plan.rows.length) {
      box.innerHTML = `<div class="production-deduct-preview-empty">目前沒有需要扣除的庫存品項。</div>`;
    } else {
      box.innerHTML = plan.rows.map(row => `
        <div class="production-deduct-row ${row.insufficient ? 'is-insufficient' : ''}">
          <strong>${escapeHtml(row.item.name)}</strong>
          <span class="production-deduct-stock">目前 ${escapeHtml(row.stock)} → 扣後 <b>${escapeHtml(row.after)}</b></span>
          <span class="production-deduct-qty">-${escapeHtml(row.quantity)} 件</span>
          <span class="production-deduct-status ${row.insufficient ? 'is-warning' : ''}">${row.insufficient ? '庫存不足・可扣成負庫存' : '可扣減'}</span>
        </div>`).join('');
    }

    const totalQty = plan.rows.reduce((sum,row)=>sum+Number(row.quantity||0),0);
    totals.textContent = `將扣 ${plan.rows.length} 個庫存品項，共 ${totalQty} 件`;
    const blockers = [];
    if (unmappedProducts) blockers.push(`${unmappedProducts} 個商品待對應`);
    if (issueCount) blockers.push(`${issueCount} 筆解析警告`);
    if (plan.unmapped.length) blockers.push(`${plan.unmapped.length} 個庫存品項無法找到`);
    if (plan.duplicateSourceKeys.length) blockers.push(`${plan.duplicateSourceKeys.length} 個來源檔已扣過`);

    const ready = blockers.length === 0 && plan.rows.length > 0;
    const negativeWarning = plan.insufficient.length ? `${plan.insufficient.length} 個品項將扣成負庫存` : '';
    badge.className = `production-preview-badge ${ready ? (negativeWarning ? 'is-warning' : 'is-ready') : 'is-warning'}`;
    badge.textContent = ready ? (negativeWarning ? `✓ 可扣庫存｜${negativeWarning}` : '✓ 已可扣庫存') : blockers.join('｜');
    if (button) {
      button.disabled = !ready;
      button.textContent = ready ? `確認扣庫存（${totalQty} 件）` : '確認扣庫存';
    }
    renderProductionTransactionStatus();
  }

  async function confirmProductionDeduction() {
    if (!lastAnalysis) return;
    const plan = buildDeductionPlan(lastAnalysis);
    const issueCount = actionableIssues(lastAnalysis).length;
    const unmappedProducts = (lastAnalysis.summary?.productRows || []).filter(row => !["mapped","stats"].includes(productInventoryMappingStatus(row.name).status)).length;
    if (issueCount || unmappedProducts || plan.unmapped.length || plan.duplicateSourceKeys.length || !plan.rows.length) {
      renderDeductPreview(lastAnalysis);
      updateProductionStatus("目前仍有項目無法安全扣庫存，請先確認扣庫存區的提示。", "error");
      return;
    }
    const totalQty = plan.rows.reduce((sum,row)=>sum+row.quantity,0);
    const preview = plan.rows.slice(0, 8).map(row => `${row.item.name} −${row.quantity}`).join("\n");
    const more = plan.rows.length > 8 ? `\n…另 ${plan.rows.length - 8} 個品項` : "";
    if (!confirm(`確定扣除本次生產庫存？\n\n${preview}${more}\n\n共 ${plan.rows.length} 個品項、${totalQty} 件。\n扣除後可使用「復原此次扣庫存」還原。`)) return;

    try {
      if (typeof data === "undefined" || !Array.isArray(data.items) || typeof saveData !== "function") throw new Error("找不到正式庫存資料");
      const now = Date.now();
      const txId = `PD${now}${Math.floor(Math.random()*1000)}`;
      const txItems = [];
      plan.rows.forEach(row => {
        const item = data.items.find(i => i.id === row.item.id);
        if (!item) throw new Error(`找不到庫存品項：${row.item.name}`);
        const oldStock = Number(item.stock || 0);
        const newStock = oldStock - row.quantity;
        item.stock = newStock;
        txItems.push({ itemId: item.id, itemName: item.name, quantity: row.quantity, oldStock, newStock });
        if (typeof addStockHistory === "function") addStockHistory(item, oldStock, newStock, "生產扣庫", `生產交易 ${txId}`);
      });
      const deductedSourceKeysForTx = new Set(plan.sourceKeys.map(String));
      const tx = {
        id: txId,
        sessionId: currentSession.id,
        status: "active",
        createdAt: now,
        createdAtText: new Date(now).toLocaleString("zh-TW", { hour12: false }),
        user: currentUserLabelForProduction(),
        email: currentUserEmailForProduction(),
        sourceKeys: plan.sourceKeys,
        folders: Array.from(new Set((lastAnalysis.records || [])
          .filter(r => deductedSourceKeysForTx.has(String(r.sourceSignature || r.path || r.filename || "")))
          .map(r => splitPath(r.path || r.filename)[0])
          .filter(Boolean))),
        items: txItems
      };
      data.productionTransactions = Array.isArray(data.productionTransactions) ? data.productionTransactions : [];
      data.productionTransactions.unshift(tx);
      data.productionTransactions = data.productionTransactions.slice(0, 300);
      lastProductionTransactionId = txId;
      const deductedSourceKeys = deductedSourceKeysForTx;
      currentSession.records.forEach(record => {
        const sourceKey = String(record.sourceSignature || record.path || record.filename || "");
        if (Number(record.countedQuantity || 0) > 0 && deductedSourceKeys.has(sourceKey) && !recordHasActiveDeduction(record)) {
          record.deductedTransactionId = txId;
        }
      });
      saveData();
      if (typeof renderAll === "function") renderAll();
      renderSessionPanel();
      renderDeductPreview(lastAnalysis);
      setProductionFlowState(lastAnalysis);
      updateProductionStatus(`已扣除 ${plan.rows.length} 個庫存品項，共 ${totalQty} 件。`, "done");
    } catch (error) {
      console.error(error);
      updateProductionStatus(`扣庫存失敗：${error.message || error}`, "error");
      alert(`扣庫存失敗：${error.message || error}`);
    }
  }

  function undoProductionDeduction(transactionId = "") {
    const tx = transactionId ? findProductionTransaction(transactionId) : latestProductionTransaction();
    if (!tx || tx.status !== "active") return;
    if (!confirm(`確定復原此次扣庫存？\n\n會把 ${tx.items?.length || 0} 個庫存品項加回扣除前的數量，並保留復原紀錄。`)) return;
    try {
      if (typeof data === "undefined" || !Array.isArray(data.items) || typeof saveData !== "function") throw new Error("找不到正式庫存資料");
      (tx.items || []).forEach(row => {
        const item = data.items.find(i => i.id === row.itemId) || data.items.find(i => normalizeInventoryName(i.name) === normalizeInventoryName(row.itemName));
        if (!item) throw new Error(`找不到庫存品項：${row.itemName}`);
        const oldStock = Number(item.stock || 0);
        const newStock = oldStock + Number(row.quantity || 0);
        item.stock = newStock;
        if (typeof addStockHistory === "function") addStockHistory(item, oldStock, newStock, "生產扣庫復原", `復原生產交易 ${tx.id}`);
      });
      tx.status = "reverted";
      tx.revertedAt = Date.now();
      tx.revertedAtText = new Date(tx.revertedAt).toLocaleString("zh-TW", { hour12: false });
      tx.revertedBy = currentUserLabelForProduction();
      tx.revertedEmail = currentUserEmailForProduction();
      currentSession.records.forEach(record => { if (record.deductedTransactionId === tx.id) record.deductedTransactionId = ""; });
      saveData();
      if (typeof renderAll === "function") renderAll();
      renderSessionPanel();
      renderDeductPreview(lastAnalysis);
      setProductionFlowState(lastAnalysis);
      updateProductionStatus("已復原此次扣庫存，庫存數量已加回。", "done");
    } catch (error) {
      console.error(error);
      updateProductionStatus(`復原失敗：${error.message || error}`, "error");
      alert(`復原失敗：${error.message || error}`);
    }
  }

  function renderAnalysis(analysis) {
    renderSummary(analysis);
    setProductionFlowState(analysis);
    renderDeductPreview(analysis);
    const productRowsAll = (analysis.summary.productRows || []).map(row => {
      const change = lastProductChanges.get(row.name) || null;
      return { ...row, _change: change, _rowClass: change ? "production-changed-row" : "" };
    }).sort((a, b) => {
      const rank = value => value?._change?.type === "new" ? 0 : value?._change?.type === "updated" ? 1 : 2;
      return rank(a) - rank(b) || b.quantity - a.quantity || a.name.localeCompare(b.name, "zh-Hant");
    });
    const keyword = (productSearchTerm || "").trim().toLowerCase();
    let productRows = productViewMode === "changed" ? productRowsAll.filter(row => row._change) : productRowsAll;
    if (keyword) productRows = productRows.filter(row => String(row.name || "").toLowerCase().includes(keyword));
    const productCountHint = $("productionProductCountHint");
    if (productCountHint) {
      const mappingStats = productRowsAll.reduce((acc, row) => {
        const status = productInventoryMappingStatus(row.name).status;
        if (status === "mapped") acc.mapped += 1;
        else if (status === "stats") acc.stats += 1;
        else acc.unmapped += 1;
        return acc;
      }, { mapped: 0, stats: 0, unmapped: 0 });
      const scope = productViewMode === "changed" ? `本次異動 ${lastProductChanges.size} 項` : `共 ${productRowsAll.length} 項`;
      const mappingText = `可扣 ${mappingStats.mapped}｜僅統計 ${mappingStats.stats}｜需處理 ${mappingStats.unmapped}`;
      productCountHint.textContent = keyword ? `${scope}｜${mappingText}｜搜尋顯示 ${productRows.length} 項` : `${scope}｜${mappingText}`;
    }
    if (selectedProductName && !productRowsAll.some(row => row.name === selectedProductName)) selectedProductName = "";
    renderSimpleTable($("productionProductResult"), productRows, [
      { label: "商品", html: true, render: row => {
        const badge = row._change?.type === "new"
          ? `<span class="production-change-badge is-new">新增</span>`
          : row._change?.type === "updated"
            ? `<span class="production-change-badge is-updated">${row._change.delta > 0 ? "+" : ""}${escapeHtml(row._change.delta)}</span>`
            : "";
        return `<button type="button" class="production-product-select-btn ${row.name === selectedProductName ? "is-active" : ""}" data-product="${escapeHtml(row.name)}"><span class="production-product-toggle-icon">${row.name === selectedProductName ? "▾" : "▸"}</span>${escapeHtml(row.name)}</button>${badge}${row.variants?.length ? `<div class="production-variant-list">${row.variants.map(v => `<span>${escapeHtml(v.name)} ${escapeHtml(v.quantity)}</span>`).join("")}</div>` : ""}`;
      } },
      { label: "數量", key: "quantity", num: true },
      { label: "單位", key: "unit" },
      { label: "庫存對應", html: true, render: row => mappingStatusHtml(row.name) },
      { label: "操作", html: true, render: row => {
        const state = productInventoryMappingStatus(row.name);
        if (state.status === "mapped" || state.status === "stats") return `<span class="production-no-action">—</span>`;
        return `<button type="button" class="secondary small production-product-map-btn" data-product="${escapeHtml(row.name)}">處理</button>`;
      } }
    ], keyword ? "沒有符合搜尋的商品" : "尚無商品統計");
    renderInlineProductDetail(selectedProductName);
    renderProductDetailPanel(selectedProductName);
    renderSimpleTable($("productionSourceResult"), analysis.summary.sourceRows, [
      { label: "平台", key: "name" },
      { label: "數量", key: "quantity", num: true }
    ], "尚無平台統計");
    renderSimpleTable($("productionTagResult"), analysis.summary.tagRows, [
      { label: "標籤", key: "name" },
      { label: "數量", key: "quantity", num: true }
    ], "尚無標籤統計");
    renderSimpleTable($("productionProcessResult"), analysis.summary.processRows, [
      { label: "製程", key: "name" },
      { label: "數量", key: "quantity", num: true }
    ], "尚無製程統計");

    const detailRows = [...analysis.records].sort((a, b) => (b.countedQuantity || 0) - (a.countedQuantity || 0) || String(a.product).localeCompare(String(b.product), "zh-Hant"));
    renderSimpleTable($("productionDetailResult"), detailRows, [
      { label: "計算", render: r => r.countedQuantity },
      { label: "商品", key: "product" },
      { label: "庫存扣料預覽", render: r => stockDetailsText(r.stockDetails) },
      { label: "來源", key: "source" },
      { label: "標籤", render: r => r.tags.join("、") || "無" },
      { label: "製程", key: "process" },
      { label: "顏色", render: r => r.colors.join("、") || "-" },
      { label: "製作屬性", render: r => r.productionAttribute || "-" },
      { label: "合併", render: r => r.mergeReason || (r.mergedByFolder ? "資料夾優先" : "") },
      { label: "操作", html: true, render: r => `<button type="button" class="secondary small production-record-product-btn" data-path="${escapeHtml(r.path)}" data-file="${escapeHtml(r.filename)}">指定商品</button>` },
      { label: "檔名", key: "filename" }
    ], "尚無明細");

    const actionIssues = actionableIssues(analysis);
    const infoIssues = informationalIssues(analysis);
    const actionCountEl = $("productionIssueActionCount");
    const infoCountEl = $("productionIssueInfoCount");
    const infoSummaryEl = $("productionIssueInfoSummary");
    if (actionCountEl) {
      actionCountEl.textContent = actionIssues.length ? `需要處理 ${actionIssues.length} 筆` : "✓ 無需處理";
      actionCountEl.classList.toggle("is-clear", actionIssues.length === 0);
    }
    if (infoCountEl) infoCountEl.textContent = infoIssues.length ? `格式提示 ${infoIssues.length} 筆` : "";
    if (infoSummaryEl) infoSummaryEl.textContent = infoIssues.length ? `${infoIssues.length} 筆｜皆已成功計入，不需要操作` : "目前沒有格式提示";

    renderSimpleTable($("productionIssueActionResult"), actionIssues, [
      { label: "狀態", render: () => "需確認" },
      { label: "商品", key: "product" },
      { label: "原因", render: r => r.issues.join("；") },
      { label: "建議處理", render: reviewSuggestion },
      { label: "操作", render: renderIssueActions, html: true },
      { label: "檔名", key: "filename" }
    ], "✓ 目前沒有需要處理的解析問題");

    renderSimpleTable($("productionIssueInfoResult"), infoIssues, [
      { label: "狀態", html: true, render: () => `<span class="production-info-status">✓ 已計入</span>` },
      { label: "商品", key: "product" },
      { label: "提示", render: r => r.issues.join("；") },
      { label: "目前結果", render: reviewSuggestion },
      { label: "操作", html: true, render: () => `<span class="production-info-no-action">不需操作</span>` },
      { label: "檔名", key: "filename" }
    ], "目前沒有格式提示");

    $("productionExportCsvBtn").disabled = false;
  }

  function learnedRuleEntries() {
    return Object.entries(runtimeRules.productManualMappings || {}).map(([source, rule]) => ({
      source,
      details: Array.isArray(rule?.details) ? rule.details : [],
      mode: rule?.mode || ""
    }));
  }

  function learnedRuleTargetText(details = [], mode = "") {
    return details.map(detail => {
      const rawQty = mode === "per-unit" ? Number(detail.perUnitQty ?? detail.quantity ?? 1) : Number(detail.quantity || 1);
      const qty = Number.isFinite(rawQty) ? Math.max(1, Math.round(rawQty)) : 1;
      const suffix = qty !== 1 ? ` × ${qty}` : "";
      return `${detail.item}${suffix}`;
    }).join("、") || "未指定";
  }

  function renderLearningRules() {
    const el = $("productionLearningRuleList");
    const hint = $("productionLearningCountHint");
    if (!el) return;
    const keyword = (learningSearchTerm || "").trim().toLowerCase();
    const all = learnedRuleEntries().sort((a, b) => a.source.localeCompare(b.source, "zh-Hant"));
    const rows = keyword ? all.filter(row => `${row.source} ${learnedRuleTargetText(row.details, row.mode)}`.toLowerCase().includes(keyword)) : all;
    if (hint) hint.textContent = keyword ? `顯示 ${rows.length} / ${all.length} 筆規則` : `${all.length} 筆規則`;
    if (!rows.length) {
      el.innerHTML = `<div class="production-side-empty">${keyword ? "沒有符合搜尋的規則。" : "目前沒有永久學習規則。"}</div>`;
      return;
    }
    el.innerHTML = rows.map(row => `
      <div class="production-learning-rule-row">
        <div class="production-learning-rule-name">${escapeHtml(row.source)}</div>
        <div class="arrow">→</div>
        <div class="production-learning-rule-target">${escapeHtml(learnedRuleTargetText(row.details, row.mode))}</div>
        <button type="button" class="secondary small danger-text production-learning-delete-btn" data-source="${escapeHtml(row.source)}">取消永久記憶</button>
      </div>`).join("");
  }

  function removeLearningRule(sourceName) {
    const source = String(sourceName || "");
    if (!source || !runtimeRules.productManualMappings?.[source]) return;
    if (!confirm(`確定取消這筆永久記憶？\n\n${source} → ${learnedRuleTargetText(runtimeRules.productManualMappings[source].details, runtimeRules.productManualMappings[source].mode || "")}\n\n只影響未來分析；目前畫面和既有庫存異動不會自動回復。`)) return;
    delete runtimeRules.productManualMappings[source];
    saveRuntimeRules();
    renderLearningRules();
    updateProductionStatus("已取消永久記憶；下次分析將重新依檔名判斷。", "done");
  }

  function loadDemo() {
    $("productionFilenameInput").value = [
      "(P)名牌(黑)(x20)_ccariuss_1LL.ai",
      "(G)(急件)USB(Type-C)(x5)_王小明.pdf",
      "(樣品)軍牌(單)(金,銀,玫瑰,黑)(各x20)_白_EM.ai",
      "黃銅吊飾(長)(雙)(x1)_王小明_正.ai",
      "黃銅吊飾(長)(雙)(x1)_王小明_背.ai",
      "戒指盒_白_1EM_now314138.pdf",
      "戒指盒_彩_1EM_now314138.pdf",
      "兩用名片架_yangyari_3LL_內.ai",
      "兩用名片架_yangyari_3LL_外.ai",
      "金屬製作檔/2026-07-07/名牌(玫瑰)(x100)/01.ai",
      "金屬製作檔/2026-07-07/名牌(玫瑰)(x100)/02.ai",
      "名牌(黑)(xx20).ai"
    ].join("\n");
  }

  function runAnalysis() {
    updateProductionStatus("正在分析新增資料…", "running");
    const hasDroppedFolders = droppedProductionEntries.length > 0;
    const mode = hasDroppedFolders ? "all" : ($("productionModeInput")?.value || "single");
    const dateValue = $("productionDateInput")?.value || todayString();
    const startDate = $("productionStartDateInput")?.value || dateValue;
    const endDate = $("productionEndDateInput")?.value || startDate;

    const droppedPending = hasDroppedFolders
      ? droppedProductionEntries.filter(entry => !analyzedDroppedEntryKeys.has(productionEntryKey(entry)))
      : [];
    const otherEntries = dedupeProductionEntries([
      ...entriesFromFileInput(),
      ...entriesFromTextarea()
    ]);
    const rawEntries = dedupeProductionEntries(hasDroppedFolders ? [...droppedPending, ...otherEntries] : otherEntries);

    if (hasDroppedFolders && !droppedPending.length && !otherEntries.length) {
      renderDroppedFolderSummary();
      renderSessionPanel();
      updateProductionStatus("目前沒有新增資料需要分析；已加入的拖曳資料都分析完成。", "done");
      return;
    }

    lastRawEntries = rawEntries;
    lastAnalysisOptions = { mode, dateValue, startDate, endDate };
    const entries = filterEntriesByMode(rawEntries, mode, dateValue, startDate, endDate);
    if (!rawEntries.length) {
      updateProductionStatus("尚未選擇資料夾。請先加入要分析的資料夾。", "idle");
      alert("請先選擇要分析的資料夾。");
      return;
    }
    if (!entries.length) {
      updateProductionStatus("沒有符合日期條件的檔名。請確認分析模式與日期範圍。", "idle");
      alert("所選資料夾中沒有符合日期條件的檔名。");
      return;
    }
    const analysisLabel = mode === "range" ? `${startDate}~${endDate}` : (mode === "all" ? "全部日期" : dateValue);
    const previousProductRows = lastAnalysis?.summary?.productRows || [];
    const thisAnalysis = analyze(entries, analysisLabel);
    thisAnalysis.mode = mode;
    thisAnalysis.filteredCount = entries.length;
    thisAnalysis.rawCount = rawEntries.length;
    lastAnalysis = addAnalysisToSession(thisAnalysis);
    lastAnalysis.mode = "session";
    lastAnalysis.filteredCount = currentSession.records.length;
    lastAnalysis.rawCount = currentSession.records.length;

    // 只有實際進入本次分析的拖曳檔案才標示為已分析。
    const analyzedNow = new Set(entries.map(productionEntryKey));
    droppedPending.forEach(entry => {
      const key = productionEntryKey(entry);
      if (analyzedNow.has(key)) analyzedDroppedEntryKeys.add(key);
    });

    captureAnalysisChange(previousProductRows, lastAnalysis);
    renderDroppedFolderSummary();
    renderSessionPanel();
    renderAnalysis(lastAnalysis);
    const remaining = droppedProductionEntries.filter(entry => !analyzedDroppedEntryKeys.has(productionEntryKey(entry))).length;
    updateProductionStatus(remaining
      ? `本次新增分析 ${entries.length} 個檔名；還有 ${remaining} 個檔案待分析。`
      : `分析完成：本次新增分析 ${entries.length} 個檔名；目前已加入資料全部分析完成。`, "done");
    $("productionSummaryCards")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function csvEscape(value) {
    const str = String(value ?? "");
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function exportCsv() {
    if (!lastAnalysis) return;
    const rows = [["日期", "製程", "來源", "標籤", "商品", "庫存扣料預覽", "計算數量", "原始數量", "單位", "顏色", "製作屬性", "合併狀態", "檔名", "路徑", "異常"]];
    lastAnalysis.records.forEach(r => rows.push([
      lastAnalysis.date,
      r.process,
      r.source,
      r.tags.join("、") || "無",
      r.product,
      stockDetailsText(r.stockDetails),
      r.countedQuantity,
      r.quantity,
      r.unit,
      r.colors.join("、"),
      r.productionAttribute || "",
      r.mergeReason || (r.mergedByFolder ? "資料夾優先" : ""),
      r.filename,
      r.path,
      r.issues.join("；")
    ]));
    const csv = "\ufeff" + rows.map(row => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `金雀生產分析_${lastAnalysis.date || todayString()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function singleTest() {
    const value = $("productionSingleTestInput").value.trim();
    if (!value) {
      $("productionSingleTestResult").textContent = "請先輸入檔名。";
      return;
    }
    const result = parseEntry({ filename: value, path: value }, $("productionDateInput").value || todayString());
    $("productionSingleTestResult").textContent = JSON.stringify({
      商品: result.product,
      總數量: result.quantity,
      計算數量: result.countedQuantity,
      庫存扣料預覽: result.stockDetails,
      來源: result.source,
      標籤: result.tags,
      規格或顏色: result.colors,
      模式: result.qtyMode,
      製作屬性: result.productionAttribute || "無",
      製作面: result.side || "無",
      唯一識別: result.identity,
      異常: result.issues
    }, null, 2);
  }


  function rerunLastAnalysis() {
    if (!lastRawEntries.length || !lastAnalysisOptions) return;
    const { mode, dateValue, startDate, endDate } = lastAnalysisOptions;
    const entries = filterEntriesByMode(lastRawEntries, mode, dateValue, startDate, endDate);
    const thisAnalysis = analyze(entries, mode === "range" ? `${startDate}~${endDate}` : dateValue);
    lastAnalysis = addAnalysisToSession(thisAnalysis);
    lastAnalysis.mode = "session";
    lastAnalysis.filteredCount = currentSession.records.length;
    lastAnalysis.rawCount = currentSession.records.length;
    renderSessionPanel();
    renderAnalysis(lastAnalysis);
  }

  function handleProductSelectAction(event) {
    const btn = event.target.closest(".production-product-select-btn");
    if (!btn) return false;
    const product = btn.dataset.product || "";
    selectedProductName = selectedProductName === product ? "" : product;
    if (lastAnalysis) renderAnalysis(lastAnalysis);
    return true;
  }

  function handleProductMapAction(event) {
    const btn = event.target.closest(".production-product-map-btn");
    if (!btn) return false;
    const product = btn.dataset.product || "";
    if (!product) return true;
    selectedProductName = product;
    renderProductDetailPanel(product);
    document.querySelectorAll(".production-product-select-btn").forEach(b => b.classList.toggle("is-active", b.dataset.product === product));
    const records = (lastAnalysis?.records || []).filter(r => Number(r.countedQuantity || 0) > 0 && recordContributesToProduct(r, product));
    const firstUnmapped = records.find(r => recordInventoryMapping(r, product).unmapped.length > 0);
    if (firstUnmapped) {
      openProductionProductPicker(firstUnmapped);
    } else {
      $("productionProductDetailPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    return true;
  }

  function handleProductAliasAction(event) {
    const btn = event.target.closest(".production-alias-btn");
    if (!btn) return;
    const product = btn.dataset.product || "";
    if (!product) return;
    const target = prompt("要將這個商品整理為哪個名稱？\n例如：名牌(玫瑰金) → 名牌(玫瑰)", product);
    if (!target || target.trim() === product) return;
    // 「對應庫存品項」只影響目前工作階段，不建立永久規則。
    const previousProductRows = lastAnalysis?.summary?.productRows || [];
    currentSession.records.forEach(record => {
      if (record.product === product) {
        record.originalProduct = record.product;
        record.product = target.trim();
        rebuildStockDetailsForRecord(record);
      }
    });
    lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
    captureAnalysisChange(previousProductRows, lastAnalysis);
    renderAnalysis(lastAnalysis);
  }


  let productionPickerState = { recordKey: "", originalName: "", details: [], baseQty: 1 };

  function getInventoryProductOptions() {
    try {
      // V3.48：對應狀態、商品選擇器與實際扣庫存必須共用正式庫存來源 data.items。
      // 先讀 data.items，避免 gbSortedActiveItems 在部分頁面載入順序下拿到空清單，
      // 造成「準備扣庫存有資料，但上方仍顯示尚未對應」的矛盾。
      if (typeof data !== "undefined" && Array.isArray(data.items)) {
        return data.items
          .filter(item => item && !item.disabled && String(item.name || "").trim())
          .map(item => item.name.trim());
      }
      if (window.data && Array.isArray(window.data.items)) {
        return window.data.items
          .filter(item => item && !item.disabled && String(item.name || "").trim())
          .map(item => item.name.trim());
      }
      if (typeof window.gbSortedActiveItems === "function") return window.gbSortedActiveItems().map(item => item.name).filter(Boolean);
      if (typeof gbSortedActiveItems === "function") return gbSortedActiveItems().map(item => item.name).filter(Boolean);
    } catch (error) {
      console.warn(error);
    }
    return [];
  }

  function findRecordByKey(path, file) {
    return currentSession.records.find(r => path && r.path === path) || currentSession.records.find(r => r.filename === file);
  }

  function setProductionPickerMessage(message = "", type = "") {
    const el = $("productionProductPickerMessage");
    if (!el) return;
    el.textContent = message || "";
    el.className = `production-picker-message ${type ? "is-" + type : ""}`.trim();
  }

  function addProductionPickerDetail(itemName) {
    const cleanName = String(itemName || "").trim();
    const qty = Number($("productionProductPickerQty")?.value || 1);
    if (!cleanName) {
      setProductionPickerMessage("請先搜尋並點選正式庫存品項。", "error");
      return;
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      setProductionPickerMessage("扣除數量請輸入大於 0 的整數。", "error");
      return;
    }
    productionPickerState.details.push({ item: cleanName, quantity: qty, unit: "件", note: "人工指定" });
    renderProductionPickerList();
    setProductionPickerMessage(`已加入：${cleanName} × ${qty}`, "done");
  }

  function renderProductionPickerOptions(filterText = "") {
    const box = $("productionProductPickerResults");
    if (!box) return;
    const keyword = String(filterText || "").trim().toLowerCase();
    const allOptions = getInventoryProductOptions();
    if (!keyword) {
      box.innerHTML = `<div class="production-picker-empty">請輸入關鍵字搜尋正式庫存品項。</div>`;
      return;
    }
    const options = allOptions
      .filter(name => String(name).toLowerCase().includes(keyword))
      .slice(0, 40);
    if (!options.length) {
      box.innerHTML = `<div class="production-picker-empty">找不到符合「${escapeHtml(filterText)}」的庫存品項。</div>`;
      return;
    }
    box.innerHTML = options.map(name => `
      <button type="button" class="production-picker-result" data-item="${escapeHtml(name)}">
        <span>${escapeHtml(name)}</span>
        <small>點選加入</small>
      </button>
    `).join("");
  }

  function renderProductionPickerList() {
    const list = $("productionProductPickerList");
    if (!list) return;
    if (!productionPickerState.details.length) {
      list.innerHTML = "";
      list.classList.add("hidden");
      return;
    }
    list.classList.remove("hidden");
    list.innerHTML = productionPickerState.details.map((d, idx) => `
      <div class="production-picker-row">
        <div class="production-picker-item-name">${escapeHtml(d.item)}</div>
        <label class="production-picker-row-qty"><span>扣除</span><input class="production-picker-detail-qty" data-index="${idx}" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(Math.max(1, Math.round(Number(d.quantity || 1))))}"></label>
        <button type="button" class="secondary small production-picker-remove" data-index="${idx}">移除</button>
      </div>
    `).join("");
  }

  function openProductionProductPicker(record) {
    if (!record) return;
    const searchInput = $("productionProductPickerSearch");
    if (searchInput) searchInput.value = "";
    renderProductionPickerOptions("");
    setProductionPickerMessage("");
    const key = record.path || record.filename;
    const baseQty = Number(record.countedQuantity || record.quantity || 1) || 1;
    const hasManualDetails = (record.stockDetails || []).some(d => /人工指定|永久指定|本次指定/.test(d.note || record.manualNote || ""));
    productionPickerState = {
      recordKey: key,
      originalName: record.originalParsedProduct || record.originalProduct || record.product || "",
      learnedKey: learnedMappingKey(record),
      learnedLabel: learnedMappingLabel(record),
      baseQty,
      details: hasManualDetails ? (record.stockDetails || []).filter(d => d.item && d.item !== "未解析").map(d => ({
        item: d.item,
        quantity: Math.max(1, Math.round(Number(d.quantity || baseQty))),
        unit: d.unit || record.unit || "件",
        variant: d.variant || "",
        note: "人工指定"
      })) : []
    };
    const title = $("productionProductPickerTitle");
    if (title) title.textContent = record.filename || record.product || "處理商品";
    const detectedQty = $("productionProductPickerDetectedQty");
    if (detectedQty) detectedQty.textContent = `${baseQty} ${record.unit || "件"}`;

    const existingRule = runtimeRules.productManualMappings?.[productionPickerState.learnedKey];
    const existingRuleEl = $("productionProductPickerExistingRule");
    if (existingRuleEl) {
      if (existingRule) {
        existingRuleEl.classList.remove("hidden");
        existingRuleEl.innerHTML = `<strong>已記住：</strong> ${escapeHtml(learnedRuleTargetText(existingRule.details, existingRule.mode || ""))}<button type="button" class="secondary small danger-text" id="productionPickerRemoveRuleBtn">取消記憶</button>`;
      } else {
        existingRuleEl.classList.add("hidden");
        existingRuleEl.innerHTML = "";
      }
    }

    const qty = $("productionProductPickerQty");
    if (qty) qty.value = String(baseQty);
    const permanent = $("productionProductPickerPermanent");
    if (permanent) permanent.checked = true;
    renderProductionPickerList();
    if (typeof openModal === "function") openModal("productionProductPickerModal");
    else $("productionProductPickerModal")?.classList.add("show");
  }

  function closeProductionProductPicker() {
    if (typeof closeModal === "function") closeModal("productionProductPickerModal");
    else $("productionProductPickerModal")?.classList.remove("show");
  }

  function applyStockDetailsToRecord(record, details, note) {
    if (!record || !details?.length) return;
    const cleanDetails = details.map(d => ({
      item: String(d.item || "").trim(),
      variant: splitStockItemName(d.item).variant || d.variant || "",
      quantity: Math.max(1, Math.round(Number(d.quantity || 1))),
      unit: d.unit || record.unit || "件",
      note: note || "人工指定"
    })).filter(d => d.item && Number(d.quantity) > 0);
    if (!cleanDetails.length) return;
    record.stockDetails = cleanDetails;
    record.product = cleanDetails.length === 1 ? cleanDetails[0].item : cleanDetails.map(d => d.item).join("+");
    record.quantity = cleanDetails.reduce((sum, d) => sum + Number(d.quantity || 0), 0);
    record.countedQuantity = record.quantity;
    record.variantDetails = cleanDetails.map(d => ({ name: splitStockItemName(d.item).variant || d.item, quantity: Number(d.quantity || 0) }));
    record.colors = cleanDetails.map(d => splitStockItemName(d.item).variant).filter(Boolean);
    record.issues = (record.issues || []).filter(issue => !/缺少商品名稱|無法判斷商品名稱|數量無法判斷/.test(issue));
    if (note) record.manualNote = note;
  }

  function promoteRemainingMergedRecord(removedRecord) {
    if (!removedRecord) return;
    let candidates = [];
    if (removedRecord.folderPriority && removedRecord.folderName) {
      candidates = currentSession.records.filter(r =>
        r.process === removedRecord.process &&
        r.folderName === removedRecord.folderName
      );
    } else if (removedRecord.productionAttributeFamily) {
      const identity = String(removedRecord.identity || "").replace(/[\s_-]+/g, "").toLowerCase();
      candidates = currentSession.records.filter(r =>
        r.date === removedRecord.date &&
        r.process === removedRecord.process &&
        r.source === removedRecord.source &&
        r.productionAttributeFamily === removedRecord.productionAttributeFamily &&
        String(r.identity || "").replace(/[\s_-]+/g, "").toLowerCase() === identity
      );
    }
    if (!candidates.length || candidates.some(r => Number(r.countedQuantity || 0) > 0)) return;
    const promoted = candidates[0];
    promoted.countedQuantity = Number(promoted.quantity || 0);
    promoted.mergedByFolder = false;
    promoted.mergedByProductionAttribute = false;
    promoted.mergedBySide = false;
    promoted.mergeReason = candidates.length > 1 ? promoted.mergeReason : "";
    if (!isStatsOnlyRecord(promoted)) rebuildStockDetailsForRecord(promoted);
  }

  function removeProductionRecord(recordKey) {
    const key = String(recordKey || "");
    if (!key) return;
    const record = currentSession.records.find(r => (r.path || r.filename) === key);
    if (!record) return;
    const ok = confirm(`確定要從本次分析移除此檔案嗎？

${record.filename}

只會影響目前分析結果，不會刪除原始檔案，也不會寫入庫存。`);
    if (!ok) return;
    currentSession.records = currentSession.records.filter(r => (r.path || r.filename) !== key);
    promoteRemainingMergedRecord(record);
    if (!currentSession.records.length) {
      resetSession();
      updateProductionStatus("已移除最後一筆檔案，目前沒有分析資料。", "idle");
      return;
    }
    lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
    currentSession.label = inferSessionLabel(currentSession.records, currentSession.label);
    currentSession.updatedAt = new Date().toLocaleString("zh-TW", { hour12: false });
    const sessionKeys = new Set(currentSession.records.map(recordSessionKey));
    currentSession.sources = Array.from(sessionKeys).map(sessionKey => {
      const [date, process] = sessionKey.split("|");
      const count = currentSession.records.filter(r => recordSessionKey(r) === sessionKey).length;
      return { key: sessionKey, date, process, count, updatedAt: currentSession.updatedAt };
    });
    renderSessionPanel();
    renderAnalysis(lastAnalysis);
    updateProductionStatus("已從本次分析移除該檔案，商品使用量已重新計算。", "done");
  }

  function handleRecordProductAction(event) {
    const removeBtn = event.target.closest(".production-record-remove-btn");
    if (removeBtn) {
      removeProductionRecord(removeBtn.dataset.key || "");
      return;
    }
    const btn = event.target.closest(".production-record-product-btn");
    if (!btn) return;
    const path = btn.dataset.path || "";
    const file = btn.dataset.file || "";
    const record = findRecordByKey(path, file);
    if (!record) return;
    openProductionProductPicker(record);
  }

  function handleIssueAction(event) {
    const btn = event.target.closest(".production-rule-btn");
    if (!btn) return;
    const action = btn.dataset.action;
    const token = btn.dataset.token || "";
    const file = btn.dataset.file || "";
    if (action === "token-tag" && token) {
      const label = prompt(`將 (${token}) 加入標籤名稱：`, token);
      if (!label) return;
      runtimeRules.customTags = Array.from(new Set([...(runtimeRules.customTags || []), label.trim()]));
      if (label.trim() !== token) runtimeRules.customTags = Array.from(new Set([...(runtimeRules.customTags || []), token]));
      saveRuntimeRules();
      rerunLastAnalysis();
      return;
    }
    if (action === "token-source" && token) {
      const sourceName = prompt(`將 (${token}) 加入來源名稱：`, token);
      if (!sourceName) return;
      runtimeRules.customSources = { ...(runtimeRules.customSources || {}), [token]: sourceName.trim() };
      saveRuntimeRules();
      rerunLastAnalysis();
      return;
    }
    if (action === "token-ignore" && token) {
      runtimeRules.ignoredTokens = Array.from(new Set([...(runtimeRules.ignoredTokens || []), token]));
      saveRuntimeRules();
      rerunLastAnalysis();
      updateProductionStatus("已本次/本機略過此標記；商品仍會照常計算。", "done");
      return;
    }
    if (action === "manual-product" && file) {
      const record = currentSession.records.find(r => r.filename === file || r.path === file);
      if (record) openProductionProductPicker(record);
      return;
    }
    if (action === "ignore-warning" && file) {
      const issue = btn.dataset.issue || "";
      if (issue) runtimeRules.ignoredIssues = Array.from(new Set([...(runtimeRules.ignoredIssues || []), issueKey(file, issue)]));
      saveRuntimeRules();
      rerunLastAnalysis();
    }
  }


  function handleSessionAction(event) {
    const editBtn = event.target.closest(".production-session-edit-btn");
    const removeBtn = event.target.closest(".production-session-remove-btn");
    if (!editBtn && !removeBtn) return;
    const key = (editBtn || removeBtn).dataset.key || "";
    if (!key) return;
    const source = currentSession.sources.find(s => s.key === key);
    if (!source) return;
    if (editBtn) {
      const nextName = prompt("請輸入新的製程名稱：", source.process || "");
      if (!nextName || !nextName.trim()) return;
      currentSession.records.forEach(record => {
        if (recordSessionKey(record) === key) record.process = nextName.trim();
      });
      lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
      addAnalysisToSession({ records: [], date: currentSession.label });
      lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
      renderSessionPanel();
      renderAnalysis(lastAnalysis);
      updateProductionStatus("已修改製程名稱，不需要重新上傳資料夾。", "done");
      return;
    }
    if (removeBtn) {
      if (!confirm(`確定移除「${source.date}｜${source.process}」這次分析？\n這只會從目前畫面移除，不會影響正式庫存。`)) return;
      currentSession.records = currentSession.records.filter(record => recordSessionKey(record) !== key);
      lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, inferSessionLabel(currentSession.records, currentSession.label));
      currentSession.label = lastAnalysis.date;
      addAnalysisToSession({ records: [], date: currentSession.label });
      lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
      renderSessionPanel();
      renderAnalysis(lastAnalysis);
      updateProductionStatus("已移除該資料夾分析結果。", "done");
    }
  }

  function init() {
    if (!$("production")) return;
    // V3.20.1: ensure the V3.17+ compact UI stylesheet scope is active even when index.html is an older compatible version.
    $("production").classList.add("production-center", "production-ux-v322", "production-ux-v325");
    // V3.20：版本提示由 JS 同步，避免 index.html 仍顯示舊版文字造成誤解。
    document.querySelectorAll("#production .production-version-badge").forEach(el => {
      el.textContent = "V3.48 對應狀態正式庫存來源修正";
    });
    const dateInput = $("productionDateInput");
    if (dateInput && !dateInput.value) dateInput.value = todayString();
    const startInput = $("productionStartDateInput");
    const endInput = $("productionEndDateInput");
    if (startInput && !startInput.value) startInput.value = todayString();
    if (endInput && !endInput.value) endInput.value = todayString();
    const modeInput = $("productionModeInput");
    const syncMode = () => {
      const mode = modeInput?.value || "single";
      document.querySelectorAll(".production-date-single").forEach(el => el.classList.toggle("hidden", mode !== "single"));
      document.querySelectorAll(".production-date-range").forEach(el => el.classList.toggle("hidden", mode !== "range"));
    };
    modeInput?.addEventListener("change", syncMode);
    syncMode();

    const folderInput = $("productionFileInput");
    const folderText = $("productionSelectedFolderText");
    const folderButton = $("productionChooseFolderBtn");

    // V3.19：不要只依賴 label/for 觸發資料夾選擇。
    // 某些瀏覽器在 input 被視覺隱藏後，label 觸發可能不穩定；
    // 改由使用者點擊時明確呼叫 input.click()，並先清空 value，
    // 這樣即使連續選同一個資料夾也會再次觸發 change。
    folderButton?.addEventListener("click", event => {
      event.preventDefault();
      if (!folderInput) {
        updateProductionStatus("找不到資料夾選擇元件，請重新整理頁面後再試。", "error");
        return;
      }
      try {
        folderInput.value = "";
        folderInput.click();
      } catch (error) {
        console.error("production folder picker failed:", error);
        updateProductionStatus("無法開啟資料夾選擇器，請重新整理頁面後再試。", "error");
      }
    });

    // V3.44：同一工作階段可依序分析、扣除多個資料夾；已扣批次不會鎖住新批次。
    // 過去選取資料夾只更新提示文字，沒有加入 droppedProductionEntries，
    // 因此右側「本次生產資料」看不到批次。現在統一加入、去重、顯示待分析狀態。
    function addEntriesToProductionQueue(incoming, sourceLabel = "資料夾") {
      if (!incoming?.length) return { added: 0, duplicateCount: 0, pending: 0 };
      const existingKeys = new Set(droppedProductionEntries.map(productionEntryKey));
      const incomingUnique = dedupeProductionEntries(incoming);
      const now = new Date().toISOString();
      let duplicateCount = 0;
      incomingUnique.forEach(entry => {
        const batch = productionBatchInfo(entry);
        droppedBatchLastAddedAt.set(batch.key, now);
        if (existingKeys.has(productionEntryKey(entry))) {
          duplicateCount += 1;
          droppedBatchDuplicateCounts.set(batch.key, (droppedBatchDuplicateCounts.get(batch.key) || 0) + 1);
        }
      });
      const before = droppedProductionEntries.length;
      droppedProductionEntries = dedupeProductionEntries([...droppedProductionEntries, ...incomingUnique]);
      const added = droppedProductionEntries.length - before;
      renderDroppedFolderSummary();
      renderSessionPanel();
      const pending = droppedProductionEntries.filter(entry => !analyzedDroppedEntryKeys.has(productionEntryKey(entry))).length;
      const duplicateText = duplicateCount ? `；另有 ${duplicateCount} 個重複檔案已自動略過` : "";
      updateProductionStatus(`已從${sourceLabel}加入 ${added} 個新檔案${duplicateText}；目前有 ${pending} 個檔案待分析。`, "done");
      return { added, duplicateCount, pending };
    }

    folderInput?.addEventListener("change", () => {
      const files = Array.from(folderInput.files || []);
      if (!files.length) {
        if (folderText) folderText.textContent = droppedProductionEntries.length ? folderText.textContent : "尚未選擇資料夾";
        updateProductionStatus("尚未選擇資料夾。", "idle");
        return;
      }
      const incoming = entriesFromFileInput();
      const firstPath = files[0].webkitRelativePath || files[0].name || "";
      const rootFolder = firstPath.split("/")[0] || "已選擇資料夾";
      const result = addEntriesToProductionQueue(incoming, `選取的「${rootFolder}」`);
      // 已經複製成分析佇列資料，清空 input，避免 runAnalysis 再從 FileList 重複讀一次。
      folderInput.value = "";
      if (result.added === 0 && result.duplicateCount > 0) {
        updateProductionStatus(`「${rootFolder}」已存在本次生產資料；${result.duplicateCount} 個重複檔案已略過，目前仍有 ${result.pending} 個檔案待分析。`, "done");
      }
    });

    const dropZone = $("productionDropZone");
    const preventDrag = event => { event.preventDefault(); event.stopPropagation(); };
    ["dragenter", "dragover"].forEach(type => dropZone?.addEventListener(type, event => {
      preventDrag(event);
      dropZone.classList.add("is-dragover");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }));
    ["dragleave", "dragend"].forEach(type => dropZone?.addEventListener(type, event => {
      preventDrag(event);
      dropZone.classList.remove("is-dragover");
    }));
    dropZone?.addEventListener("drop", async event => {
      preventDrag(event);
      dropZone.classList.remove("is-dragover");
      updateProductionStatus("正在讀取拖曳的資料夾…", "running");
      const incoming = await collectDroppedProductionEntries(event.dataTransfer);
      if (!incoming.length) {
        updateProductionStatus("沒有讀到可分析的檔案；請確認拖入的是資料夾。", "idle");
        return;
      }
      addEntriesToProductionQueue(incoming, "拖曳的資料夾");
    });

    renderSessionPanel();
    setProductionFlowState(lastAnalysis);
    renderDeductPreview(lastAnalysis);
    updateProductionStatus("尚未開始分析。請先加入資料夾，再按「分析新增資料」。", "idle");
    renderLearningRules();
    $("productionAnalyzeBtn")?.addEventListener("click", runAnalysis);
    $("productionConfirmDeductBtn")?.addEventListener("click", confirmProductionDeduction);
    $("productionIssuePanel")?.addEventListener("click", handleIssueAction);
    $("productionSessionList")?.addEventListener("click", handleSessionAction);
    $("productionProductResult")?.addEventListener("click", event => {
      if (event.target.closest(".production-record-remove-btn, .production-record-product-btn")) {
        handleRecordProductAction(event);
        return;
      }
      if (handleProductSelectAction(event)) return;
      if (handleProductMapAction(event)) return;
      handleProductAliasAction(event);
    });
    $("productionProductDetailPanel")?.addEventListener("click", handleRecordProductAction);
    $("productionDetailResult")?.addEventListener("click", handleRecordProductAction);
    $("productionProductPickerSearch")?.addEventListener("input", event => {
      renderProductionPickerOptions(event.target.value || "");
      setProductionPickerMessage("");
    });
    $("productionProductPickerResults")?.addEventListener("click", event => {
      const btn = event.target.closest(".production-picker-result");
      if (!btn) return;
      addProductionPickerDetail(btn.dataset.item || "");
    });
    $("productionProductPickerList")?.addEventListener("click", event => {
      const btn = event.target.closest(".production-picker-remove");
      if (!btn) return;
      productionPickerState.details.splice(Number(btn.dataset.index), 1);
      renderProductionPickerList();
    });
    $("productionProductPickerList")?.addEventListener("change", event => {
      const input = event.target.closest(".production-picker-detail-qty");
      if (!input) return;
      const idx = Number(input.dataset.index);
      const qty = Number(input.value);
      if (!Number.isInteger(qty) || qty <= 0 || !productionPickerState.details[idx]) {
        input.value = productionPickerState.details[idx] ? String(productionPickerState.details[idx].quantity) : "1";
        setProductionPickerMessage("扣除數量只能輸入大於 0 的整數。", "error");
        return;
      }
      productionPickerState.details[idx].quantity = qty;
      setProductionPickerMessage("已更新扣除數量。", "done");
    });
    $("productionPickerStatsOnlyBtn")?.addEventListener("click", () => {
      const record = currentSession.records.find(r => (r.path || r.filename) === productionPickerState.recordKey);
      if (!record) return;
      const permanentFlag = !!$("productionProductPickerPermanent")?.checked;
      setStatsOnlyForRecord(record, permanentFlag, false);
      closeProductionProductPicker();
      lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
      renderAnalysis(lastAnalysis);
      renderLearningRules();
      updateProductionStatus(permanentFlag ? "已記住：這個商品僅統計、不扣庫存。" : "這個商品本次不扣庫存。", "done");
    });
    $("productionProductPickerCancelBtn")?.addEventListener("click", closeProductionProductPicker);
    $("productionProductPickerSaveBtn")?.addEventListener("click", () => {
      const record = currentSession.records.find(r => (r.path || r.filename) === productionPickerState.recordKey);
      if (!record) return;
      if (!productionPickerState.details.length) {
        setProductionPickerMessage("請至少加入一個庫存品項。", "error");
        return;
      }
      const permanent = !!$("productionProductPickerPermanent")?.checked;
      const originalName = productionPickerState.originalName || record.originalParsedProduct || record.product;
      const learnedKey = productionPickerState.learnedKey || learnedMappingKey(record, originalName);
      const previousProductRows = lastAnalysis?.summary?.productRows || [];
      const baseQty = Number(productionPickerState.baseQty || record.countedQuantity || record.quantity || 1) || 1;
      if (permanent) {
        const ruleDetails = productionPickerState.details.map(d => ({
          item: d.item,
          quantity: Math.max(1, Math.round(Number(d.quantity || 1))),
          unit: d.unit || record.unit || "件",
          note: "永久指定"
        }));
        runtimeRules.productManualMappings = { ...(runtimeRules.productManualMappings || {}), [learnedKey]: { mode: "fixed", details: ruleDetails } };
      } else {
        runtimeRules.manualItems = { ...(runtimeRules.manualItems || {}), [productionPickerState.recordKey]: { details: productionPickerState.details } };
      }
      saveRuntimeRules();
      // 修改對應只作用在目前點選的來源檔。即使勾選「記住」，也不立即覆蓋本次分析中的其他同名檔案。
      // 記住的規則只供未來重新分析時使用，且以「商品＋原始規格/顏色」為條件。
      currentSession.records.forEach(r => {
        const sameRecord = (r.path || r.filename) === productionPickerState.recordKey;
        if (!sameRecord) return;
        r.statsOnly = false;
        applyStockDetailsToRecord(r, productionPickerState.details, permanent ? "永久指定" : "本次指定");
      });
      closeProductionProductPicker();
      lastAnalysis = aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
      captureAnalysisChange(previousProductRows, lastAnalysis);
      renderAnalysis(lastAnalysis);
      renderLearningRules();
      updateProductionStatus(permanent ? "已記住這個商品的扣庫存方式。" : "已套用本次扣庫存設定。", "done");
    });
    $("productionProductViewAllBtn")?.addEventListener("click", () => {
      productViewMode = "all";
      $("productionProductViewAllBtn")?.classList.add("is-active");
      $("productionProductViewChangedBtn")?.classList.remove("is-active");
      if (lastAnalysis) renderAnalysis(lastAnalysis);
    });
    $("productionProductViewChangedBtn")?.addEventListener("click", () => {
      productViewMode = "changed";
      $("productionProductViewChangedBtn")?.classList.add("is-active");
      $("productionProductViewAllBtn")?.classList.remove("is-active");
      if (lastAnalysis) renderAnalysis(lastAnalysis);
    });
    $("productionProductSearchInput")?.addEventListener("input", event => {
      productSearchTerm = event.target.value || "";
      if (lastAnalysis) renderAnalysis(lastAnalysis);
    });
    $("productionLearningSearchInput")?.addEventListener("input", event => {
      learningSearchTerm = event.target.value || "";
      renderLearningRules();
    });
    $("productionLearningRuleList")?.addEventListener("click", event => {
      const btn = event.target.closest(".production-learning-delete-btn");
      if (btn) removeLearningRule(btn.dataset.source || "");
    });
    $("productionProductPickerExistingRule")?.addEventListener("click", event => {
      if (!event.target.closest("#productionPickerRemoveRuleBtn")) return;
      removeLearningRule(productionPickerState.learnedKey || productionPickerState.originalName);
      const el = $("productionProductPickerExistingRule");
      if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
      const permanent = $("productionProductPickerPermanent");
      if (permanent) permanent.checked = false;
      setProductionPickerMessage("已取消永久記憶；目前視窗仍可重新指定。", "done");
    });
    $("productionDemoBtn")?.addEventListener("click", loadDemo);
    $("productionClearBtn")?.addEventListener("click", () => {
      const textarea = $("productionFilenameInput");
      if (textarea) textarea.value = "";
      const fileInput = $("productionFileInput");
      if (fileInput) fileInput.value = "";
      droppedProductionEntries = [];
      analyzedDroppedEntryKeys = new Set();
      droppedBatchDuplicateCounts = new Map();
      droppedBatchLastAddedAt = new Map();
      const folderText = $("productionSelectedFolderText");
      if (folderText) folderText.textContent = "尚未加入資料夾";
      renderSessionPanel();
      const processInput = $("productionProcessInput");
      if (processInput) processInput.value = "";
      updateProductionStatus("已清除已選資料夾/輸入欄位；目前分析結果仍保留。", "idle");
    });
    $("productionExportCsvBtn")?.addEventListener("click", exportCsv);
    $("productionSingleTestBtn")?.addEventListener("click", singleTest);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.GBProductionAnalyzer = {
    parseFullName,
    parseEntry,
    analyze
  };
})();
