(function () {
  "use strict";

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
      if (!raw) return { customSources: {}, customTags: [], ignoredTokens: [], ignoredIssues: [], manualItems: {} };
      return { customSources: {}, customTags: [], ignoredTokens: [], ignoredIssues: [], manualItems: {}, ...JSON.parse(raw) };
    } catch (error) {
      return { customSources: {}, customTags: [], ignoredTokens: [], ignoredIssues: [], manualItems: {} };
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
  const SIDE_WORDS = ["正", "背", "正面", "背面"];
  const PRODUCTION_ATTRIBUTE_FAMILIES = {
    side: ["正", "背", "正面", "背面"],
    printLayer: ["白", "彩", "白檔", "彩檔", "底白", "底色"]
  };
  const KNOWN_PRODUCTION_ATTRIBUTES = Object.values(PRODUCTION_ATTRIBUTE_FAMILIES).flat();
  const KNOWN_COLORS = ["玫瑰金", "玫瑰", "霧黑", "霧銀", "霧金", "胡桃棕", "花梨木", "原木", "透明", "奶茶", "深", "淺", "金", "銀", "黑", "白", "紅", "藍", "綠"];
  const IGNORE_PRODUCT_WORDS = ["刻白", "刻黑", "雕白", "雕黑", "雷雕", "彩印", "白墨", "底白"];
  const DESIGNER_CODE_RE = /^\d+[A-Z]{2,4}$/i;

  let lastAnalysis = null;
  let lastRawEntries = [];
  let lastAnalysisOptions = null;
  let currentSession = createEmptySession();

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
    const normalized = String(text || "").replace(/、/g, ",").replace(/，/g, ",");
    return normalized.split(",").map(x => x.trim()).filter(Boolean);
  }

  function isKnownColorText(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (KNOWN_COLORS.includes(value)) return true;
    if (/[，,、]/.test(value)) {
      const parts = parseColorList(value);
      return parts.length > 0 && parts.every(part => KNOWN_COLORS.includes(part));
    }
    return false;
  }

  function colorsFromLastMeaningfulGroup(text, groups, stopIndex) {
    for (let i = stopIndex; i >= 0; i--) {
      const group = groups[i];
      if (!group) continue;
      if (isKnownColorText(group.text)) return parseColorList(group.text);
    }
    return [];
  }

  function parseProductAndQty(rawText) {
    let text = firstProductionPart(rawText).trim();
    const issues = [];
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
    return value.trim();
  }

  function normalizedBaseName(baseName) {
    return stripExtension(baseName).replace(/＿/g, "_").trim();
  }

  function normalizeProductionAttribute(attr) {
    const value = String(attr || "").replace(/\d+$/g, "").trim();
    if (["正", "正面"].includes(value)) return { attribute: "正", family: "side" };
    if (["背", "背面"].includes(value)) return { attribute: "背", family: "side" };
    if (["白", "白檔", "底白", "底色"].includes(value)) return { attribute: "白", family: "printLayer" };
    if (["彩", "彩檔"].includes(value)) return { attribute: "彩", family: "printLayer" };
    return { attribute: "", family: "" };
  }

  function detectProductionAttribute(baseName) {
    const text = normalizedBaseName(baseName);
    const segments = text.split(/[_-]+/).map(x => x.trim()).filter(Boolean);
    for (const segment of segments) {
      const normalized = normalizeProductionAttribute(segment);
      if (normalized.attribute) return normalized;
    }
    const m = text.match(/[_-](正面?|背面?|白檔?|彩檔?|底白|底色)\d*($|[_-])/);
    if (m) return normalizeProductionAttribute(m[1]);
    return { attribute: "", family: "" };
  }

  function detectSide(baseName) {
    const detected = detectProductionAttribute(baseName);
    return detected.family === "side" ? detected.attribute : "";
  }

  function removeProductionAttributesForIdentity(baseName) {
    const text = normalizedBaseName(baseName);
    return text
      .split(/([_-]+)/)
      .filter(part => {
        if (/^[_-]+$/.test(part)) return true;
        return !normalizeProductionAttribute(part).attribute;
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


  function inferDateFromPath(pathParts) {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    return (pathParts || []).find(part => datePattern.test(part)) || "";
  }

  function isDateInRange(date, start, end) {
    if (!date) return true;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  }

  function inferProcess(pathParts, dateValue) {
    if (!pathParts.length) return "未指定";
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const candidates = pathParts.slice(0, -1);
    const idx = candidates.findIndex(p => p === dateValue || datePattern.test(p));
    if (idx > 0) return candidates[idx - 1];
    if (idx === 0) return "未指定";
    return candidates[0] || "未指定";
  }

  function parseFullName(name) {
    const base = stripExtension(name);
    const leading = stripLeadingTokens(base);
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
        item: `${product}(${v.name})`,
        variant: v.name,
        quantity: Number(v.quantity || 0),
        unit: parsed.unitHint || "件",
        note: "多色拆扣"
      }));
    }

    return [{
      item: product,
      variant: (parsed.colors && parsed.colors.length === 1) ? parsed.colors[0] : "",
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


  function issueKey(filename, issue) {
    return `${filename}||${issue}`;
  }

  function applyManualItem(record) {
    const manual = runtimeRules.manualItems?.[record.filename];
    if (!manual) return record;
    if (manual.product) {
      record.product = manual.product;
      record.stockDetails = [{
        item: manual.product,
        variant: "",
        quantity: Number(manual.quantity || record.quantity || 1),
        unit: record.unit || "件",
        note: "人工指定"
      }];
      record.quantity = Number(manual.quantity || record.quantity || 1);
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
    const detectedAttribute = detectProductionAttribute(base);
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
      quantity: parsed.quantity || 0,
      unit: parsed.unitHint || "件",
      colors: parsed.colors,
      perColorQty: parsed.perColorQty,
      stockDetails: buildStockDetails(parsed),
      qtyMode: parsed.qtyMode,
      side,
      productionAttribute: detectedAttribute.attribute,
      productionAttributeFamily: detectedAttribute.family,
      identity,
      filename,
      path: entry.path || filename,
      folderPriority: !!folderCandidate,
      folderName: folderCandidate ? folderCandidate.folder : "",
      unknownStartTokens: parsed.unknownStartTokens || [],
      issues,
      mergedBySide: false,
      mergedByProductionAttribute: false,
      mergeReason: "",
      countedQuantity: parsed.quantity || 0
    };
    applyManualItem(record);
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
      return { path, filename: parts[parts.length - 1] || file.name, process: manualProcess || "" };
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

  function applyProductionAttributeMerge(records) {
    const groups = new Map();
    records.forEach(record => {
      if (!record.productionAttribute || !record.productionAttributeFamily || record.folderPriority) return;
      const key = `${record.date}|${record.process}|${record.source}|${record.product}|${record.quantity}|${record.identity}|${record.productionAttributeFamily}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    });

    groups.forEach(group => {
      const attrs = new Set(group.map(r => r.productionAttribute));
      const family = group[0]?.productionAttributeFamily || "";
      const canMerge =
        (family === "side" && attrs.has("正") && attrs.has("背")) ||
        (family === "printLayer" && attrs.has("白") && attrs.has("彩"));

      if (group.length >= 2 && canMerge) {
        const reason = family === "side" ? "正/背製作檔合併" : "白/彩製作檔合併";
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
    applyProductionAttributeMerge(records);
  }

  function summarize(records) {
    const product = new Map();
    const source = new Map();
    const tag = new Map();
    const process = new Map();
    const issues = [];

    const add = (map, key, qty) => map.set(key, (map.get(key) || 0) + qty);

    records.forEach(record => {
      const qty = record.countedQuantity || 0;
      if (qty > 0) {
        add(product, `${record.product}||${record.unit}`, qty);
        add(source, record.source || "未標示", qty);
        add(process, record.process || "未指定", qty);
        if (record.tags.length) record.tags.forEach(t => add(tag, t, qty));
      }
      if (record.issues.length) issues.push(record);
    });

    const productRows = Array.from(product.entries()).map(([key, qty]) => {
      const [name, unit] = key.split("||");
      return { name, quantity: qty, unit };
    }).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "zh-Hant"));

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
    // 同一日期＋同一製程重新分析時，預設覆蓋原本那組，避免重複累加。
    currentSession.records = currentSession.records.filter(r => !incomingKeys.has(recordSessionKey(r)));
    currentSession.records.push(...analysis.records);
    currentSession.label = inferSessionLabel(currentSession.records, analysis.date);
    currentSession.updatedAt = new Date().toLocaleString("zh-TW", { hour12: false });
    incomingKeys.forEach(key => {
      currentSession.sources = currentSession.sources.filter(s => s.key !== key);
      const [date, process] = key.split("|");
      const count = analysis.records.filter(r => recordSessionKey(r) === key).length;
      currentSession.sources.push({ key, date, process, count, updatedAt: currentSession.updatedAt });
    });
    currentSession.sources.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.process || "").localeCompare(b.process || "", "zh-Hant"));
    return aggregateAnalysisFromRecords(currentSession.records, currentSession.label);
  }

  function renderSessionPanel() {
    const labelEl = $("productionSessionLabel");
    const listEl = $("productionSessionList");
    if (labelEl) labelEl.textContent = currentSession.label || "尚未建立";
    if (!listEl) return;
    if (!currentSession.sources.length) {
      listEl.innerHTML = "分析製程後會顯示進度。";
      return;
    }
    listEl.innerHTML = currentSession.sources.map(source => `
      <div class="production-session-item">
        <span>✓ ${escapeHtml(source.date)}｜${escapeHtml(source.process)}</span>
        <strong>${escapeHtml(source.count)} 檔</strong>
      </div>
    `).join("");
  }

  function resetSession() {
    currentSession = createEmptySession();
    lastAnalysis = null;
    renderSessionPanel();
    $("productionSummaryCards").innerHTML = '<div class="production-summary-empty">尚未分析</div>';
    ["productionProductResult", "productionSourceResult", "productionTagResult", "productionProcessResult", "productionDetailResult", "productionIssueResult"].forEach(id => {
      const el = $(id);
      if (el) el.textContent = "尚未分析";
    });
    const exportBtn = $("productionExportCsvBtn");
    if (exportBtn) exportBtn.disabled = true;
  }

  function renderSummary(analysis) {
    const totalFiles = analysis.records.length;
    const totalQty = analysis.records.reduce((sum, r) => sum + (r.countedQuantity || 0), 0);
    const products = analysis.summary.productRows.length;
    const issues = analysis.summary.issues.length;
    const merged = analysis.records.filter(r => r.mergedBySide || r.mergedByFolder || r.mergedByProductionAttribute).length;
    $("productionSummaryCards").innerHTML = [
      ["掃描檔案", totalFiles],
      ["計算數量", totalQty],
      ["商品種類", products],
      ["合併檔案", merged],
      ["需要處理", issues]
    ].map(([label, value]) => `<div class="production-summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  }

  function renderSimpleTable(el, rows, columns, emptyText) {
    if (!rows.length) {
      el.innerHTML = `<p>${escapeHtml(emptyText || "沒有資料")}</p>`;
      return;
    }
    el.innerHTML = `<table class="production-table"><thead><tr>${columns.map(c => `<th class="${c.num ? "num" : ""}">${escapeHtml(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(c => `<td class="${c.num ? "num" : ""}">${escapeHtml(c.render ? c.render(row) : row[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function reviewSuggestion(record) {
    const issueText = (record.issues || []).join("；");
    if (/舊式尾端數量/.test(issueText)) return "已可計算；可按『忽略提醒』，或之後改成 (x數量)";
    if (/數量格式/.test(issueText)) return "請修正 (x數量)，例如 (x20)";
    if (/缺少商品|無法判斷商品/.test(issueText)) return "可按『指定商品』補上本次商品名稱";
    if (/未知開頭標記/.test(issueText)) return "可直接設為標籤、來源或忽略";
    return "確認是否需要新增規則";
  }

  function renderIssueActions(record) {
    const issueText = (record.issues || []).join("；");
    const token = (record.unknownStartTokens || [])[0] || "";
    const buttons = [];
    if (token) {
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="token-tag" data-token="${escapeHtml(token)}" data-file="${escapeHtml(record.filename)}">設為標籤</button>`);
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="token-source" data-token="${escapeHtml(token)}" data-file="${escapeHtml(record.filename)}">設為來源</button>`);
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="token-ignore" data-token="${escapeHtml(token)}" data-file="${escapeHtml(record.filename)}">忽略此標記</button>`);
    }
    if (/缺少商品|無法判斷商品/.test(issueText) || record.product === "未解析") {
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="manual-product" data-file="${escapeHtml(record.filename)}">指定商品</button>`);
    }
    if (/舊式尾端數量/.test(issueText)) {
      buttons.push(`<button type="button" class="secondary small production-rule-btn" data-action="ignore-warning" data-file="${escapeHtml(record.filename)}" data-issue="${escapeHtml((record.issues || [])[0] || "")}">忽略提醒</button>`);
    }
    return buttons.join(" ") || "請依建議修正檔名後重新分析";
  }

  function renderAnalysis(analysis) {
    renderSummary(analysis);
    renderSimpleTable($("productionProductResult"), analysis.summary.productRows, [
      { label: "商品", key: "name" },
      { label: "數量", key: "quantity", num: true },
      { label: "單位", key: "unit" }
    ], "尚無商品統計");
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

    renderSimpleTable($("productionDetailResult"), analysis.records, [
      { label: "計算", render: r => r.countedQuantity },
      { label: "商品", key: "product" },
      { label: "庫存扣料預覽", render: r => stockDetailsText(r.stockDetails) },
      { label: "來源", key: "source" },
      { label: "標籤", render: r => r.tags.join("、") || "無" },
      { label: "製程", key: "process" },
      { label: "顏色", render: r => r.colors.join("、") || "-" },
      { label: "製作屬性", render: r => r.productionAttribute || "-" },
      { label: "合併", render: r => r.mergeReason || (r.mergedByFolder ? "資料夾優先" : "") },
      { label: "檔名", key: "filename" }
    ], "尚無明細");

    renderSimpleTable($("productionIssueResult"), analysis.summary.issues, [
      { label: "狀態", render: () => "需確認" },
      { label: "商品", key: "product" },
      { label: "原因", render: r => r.issues.join("；") },
      { label: "建議處理", render: reviewSuggestion },
      { label: "操作", render: renderIssueActions },
      { label: "檔名", key: "filename" }
    ], "目前沒有需要處理的項目");

    $("productionExportCsvBtn").disabled = false;
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
      "金屬製作檔/2026-07-07/名牌(玫瑰)(x100)/01.ai",
      "金屬製作檔/2026-07-07/名牌(玫瑰)(x100)/02.ai",
      "名牌(黑)(xx20).ai"
    ].join("\n");
  }

  function runAnalysis() {
    const mode = $("productionModeInput")?.value || "single";
    const dateValue = $("productionDateInput")?.value || todayString();
    const startDate = $("productionStartDateInput")?.value || dateValue;
    const endDate = $("productionEndDateInput")?.value || startDate;
    const rawEntries = [...entriesFromFileInput(), ...entriesFromTextarea()];
    lastRawEntries = rawEntries;
    lastAnalysisOptions = { mode, dateValue, startDate, endDate };
    const entries = filterEntriesByMode(rawEntries, mode, dateValue, startDate, endDate);
    if (!rawEntries.length) {
      alert("請先選擇要分析的資料夾。");
      return;
    }
    if (!entries.length) {
      alert("所選資料夾中沒有符合日期條件的檔名。若你選的是日期資料夾，請確認分析日期相同；若要分析一週，請選製程資料夾那一層。");
      return;
    }
    const analysisLabel = mode === "range" ? `${startDate}~${endDate}` : (mode === "all" ? "全部日期" : dateValue);
    const thisAnalysis = analyze(entries, analysisLabel);
    thisAnalysis.mode = mode;
    thisAnalysis.filteredCount = entries.length;
    thisAnalysis.rawCount = rawEntries.length;
    lastAnalysis = addAnalysisToSession(thisAnalysis);
    lastAnalysis.mode = "session";
    lastAnalysis.filteredCount = currentSession.records.length;
    lastAnalysis.rawCount = currentSession.records.length;
    renderSessionPanel();
    renderAnalysis(lastAnalysis);
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

  function handleIssueAction(event) {
    const btn = event.target.closest(".production-rule-btn");
    if (!btn) return;
    const action = btn.dataset.action;
    const token = btn.dataset.token || "";
    const file = btn.dataset.file || "";
    if (action === "token-tag" && token) {
      const label = prompt(`將 (${token}) 設為標籤名稱：`, token);
      if (!label) return;
      runtimeRules.customTags = Array.from(new Set([...(runtimeRules.customTags || []), label.trim()]));
      if (label.trim() !== token) runtimeRules.customTags = Array.from(new Set([...(runtimeRules.customTags || []), token]));
      saveRuntimeRules();
      rerunLastAnalysis();
      return;
    }
    if (action === "token-source" && token) {
      const sourceName = prompt(`將 (${token}) 設為來源名稱：`, token);
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
      return;
    }
    if (action === "manual-product" && file) {
      const product = prompt("請輸入本次要計算的商品名稱：", "");
      if (!product) return;
      const qtyRaw = prompt("請輸入數量：", "1");
      const qty = Number(qtyRaw || 1);
      runtimeRules.manualItems = { ...(runtimeRules.manualItems || {}), [file]: { product: product.trim(), quantity: Number.isFinite(qty) && qty > 0 ? qty : 1 } };
      saveRuntimeRules();
      rerunLastAnalysis();
      return;
    }
    if (action === "ignore-warning" && file) {
      const issue = btn.dataset.issue || "";
      if (issue) runtimeRules.ignoredIssues = Array.from(new Set([...(runtimeRules.ignoredIssues || []), issueKey(file, issue)]));
      saveRuntimeRules();
      rerunLastAnalysis();
    }
  }

  function init() {
    if (!$("production")) return;
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
    renderSessionPanel();
    $("productionAnalyzeBtn")?.addEventListener("click", runAnalysis);
    $("productionIssueResult")?.addEventListener("click", handleIssueAction);
    $("productionDemoBtn")?.addEventListener("click", loadDemo);
    $("productionClearBtn")?.addEventListener("click", () => {
      const textarea = $("productionFilenameInput");
      if (textarea) textarea.value = "";
      const fileInput = $("productionFileInput");
      if (fileInput) fileInput.value = "";
      const processInput = $("productionProcessInput");
      if (processInput) processInput.value = "";
      resetSession();
    });
    $("productionNewSessionBtn")?.addEventListener("click", () => {
      if (currentSession.records.length && !confirm("確定要重新開始工作階段？目前分析結果會清空，但不會影響庫存。")) return;
      const fileInput = $("productionFileInput");
      if (fileInput) fileInput.value = "";
      resetSession();
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
