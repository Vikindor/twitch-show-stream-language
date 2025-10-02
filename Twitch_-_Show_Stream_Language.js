// ==UserScript==
// @name         Twitch - Show Stream Language
// @namespace    twitch-lang-suffix
// @version      1.3.1
// @description  Shows stream language as [EN]/[FR]/[...]. Configurable, two UIs: top-right badge or right-aligned suffix
// @author       Vikindor
// @homepageURL  https://github.com/Vikindor/twitch-show-stream-language
// @supportURL   https://vikindor.github.io/
// @license      MIT
// @match        https://www.twitch.tv/*
// @grant        none
// @inject-into  page
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ----------- CONFIG -----------
  // 'badge' or 'suffix-right'
  const VISUAL_MODE = 'suffix-right'; // <-- UI CONFIG HERE

  // ----------- DATA -----------
  const langByLogin = new Map();
  const toUpperCode = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : null);
  const isIsoLike = (v) => typeof v === 'string' && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(v.trim());

  // Language tags and codes (used for content/freeform tags)
  const tagNameToCode = new Map(Object.entries({
    'english':'EN','русский':'RU','deutsch':'DE','español':'ES','espanol':'ES',
    'português':'PT','portugues':'PT','português (brasil)':'PT-BR','portugues (brasil)':'PT-BR',
    'français':'FR','francais':'FR','italiano':'IT','polski':'PL',
    'українська':'UK','ukrainian':'UK','日本語':'JA','한국어':'KO',
    '中文':'ZH','中文（简体）':'ZH-CN','中文（繁體）':'ZH-TW','中文(简体)':'ZH-CN','中文(繁體)':'ZH-TW',
    'türkçe':'TR','turkish':'TR','svenska':'SV','dutch':'NL'
  }));
  function tagToCode(tagObj) {
    if (!tagObj) return null;
    if (typeof tagObj === 'string') return tagNameToCode.get(tagObj.trim().toLowerCase()) || null;
    const name = tagObj.localizedName || tagObj.name || tagObj.tagName || tagObj.label || tagObj.slug;
    return name ? (tagNameToCode.get(String(name).trim().toLowerCase()) || null) : null;
  }

  // ----------- GQL PARSING -----------
  function extractPair(node) {
    if (!node || typeof node !== 'object') return null;

    const login =
      (node.broadcaster && (node.broadcaster.login || node.broadcasterLogin)) ||
      node.userLogin ||
      node.login ||
      (node.channel && (node.channel.login || node.channel.name)) ||
      null;

    let lang = null;
    if (typeof node.broadcasterLanguage === 'string' && node.broadcasterLanguage) lang = node.broadcasterLanguage;
    if (!lang && typeof node.language === 'string' && isIsoLike(node.language)) lang = node.language;
    if (!lang && node.stream && typeof node.stream.language === 'string' && isIsoLike(node.stream.language)) lang = node.stream.language;
    if (!lang && node.channel) {
      const ch = node.channel;
      if (typeof ch.broadcasterLanguage === 'string' && isIsoLike(ch.broadcasterLanguage)) lang = ch.broadcasterLanguage;
      else if (typeof ch.language === 'string' && isIsoLike(ch.language)) lang = ch.language;
    }
    if (!lang) {
      const tags = Array.isArray(node.contentTags) ? node.contentTags :
                   Array.isArray(node.freeformTags) ? node.freeformTags : null;
      if (tags) {
        for (const t of tags) { const c = tagToCode(t); if (c) { lang = c; break; } }
      }
    }

    if (login && lang) return { login: String(login).toLowerCase(), lang: toUpperCode(lang) };
    return null;
  }

  function collectLanguages(any) {
    if (!any || typeof any !== 'object') return;
    const pair = extractPair(any);
    if (pair) {
      const prev = langByLogin.get(pair.login);
      if (prev !== pair.lang) {
        langByLogin.set(pair.login, pair.lang);
        queueAnnotate();
      }
    }
    if (Array.isArray(any)) {
      for (const it of any) collectLanguages(it);
    } else {
      for (const k in any) {
        if (!Object.prototype.hasOwnProperty.call(any, k)) continue;
        const v = any[k];
        if (v && typeof v === 'object') collectLanguages(v);
      }
    }
  }

  // ----------- NETWORK HOOKS -----------
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = String(args[0] || '');
      if (url.includes('/gql')) {
        p.then((res) => { res.clone().json().then(collectLanguages).catch(()=>{}); }).catch(()=>{});
      }
    } catch {}
    return p;
  };

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function PatchedXHR() {
    const xhr = new OrigXHR();
    let isGQL = false;
    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      isGQL = url && /\/gql(\?|$)/.test(String(url));
      return origOpen.call(this, method, url, ...rest);
    };
    xhr.addEventListener('load', function () {
      if (!isGQL) return;
      try {
        const ct = (xhr.getResponseHeader('content-type') || '').toLowerCase();
        if (!ct.includes('application/json')) return;
        collectLanguages(JSON.parse(xhr.responseText));
      } catch {}
    });
    return xhr;
  };

  // ----------- UI -----------
  const ANY_LINK_SELECTORS = [
    'a[data-a-target="preview-card-title-link"]',
    'a[data-a-target="preview-card-channel-link"]',
    'a[data-test-selector="preview-card-title-link"]',
    'a[data-test-selector="preview-card-channel-link"]',
    'a[data-test-selector="TitleAndChannel__titleLink"]',
    'a[data-test-selector="TitleAndChannel__channelLink"]',
  ].join(',');

  const CHANNEL_LINK_SELECTORS = [
    'a[data-a-target="preview-card-channel-link"]',
    'p[data-a-target="preview-card-channel-link"]',
    'a[data-test-selector="preview-card-channel-link"]',
    'a[data-test-selector="TitleAndChannel__channelLink"]',
    'p[data-test-selector="TitleAndChannel__channelLink"]',
  ].join(',');

  function getLoginFromLink(node) {
    const a = node.tagName === 'A' ? node : node.closest('a[href^="/"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\/([a-zA-Z0-9_]+)(?:\/|$)/);
    return m ? m[1].toLowerCase() : null;
  }

  // Suffix, right-aligned against username
  function ensureRightSuffix(node, login) {
    const card = node.closest('article,[data-target="directory-first-item"]') || node;

    let row = node.parentElement || node;
    if (row && row.nextElementSibling && row.parentElement) {
      row = row.parentElement;
    }

    let badge = row.querySelector('.__langSuffixRight');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = '__langSuffixRight';
      badge.style.marginLeft = 'auto';
      badge.style.whiteSpace = 'nowrap';
      badge.style.fontWeight = '600';
      badge.style.opacity = '0.9';
      badge.style.order = '999';
      row.appendChild(badge);
    }
    badge.style.color = 'rgb(162,126,217)';
    badge.style.pointerEvents = 'none';
    badge.textContent = `[${langByLogin.get(login) || '??'}]`;

    card.querySelectorAll('.__langSuffixRight').forEach((el) => {
      if (el !== badge && el.parentElement !== row) el.remove();
    });
  }

  // Badge on thumbnail, top-right
  function ensureBadge(a, login) {
    const article = a.closest('article') || a.closest('div[data-target="directory-first-item"]') || a.closest('div') || a;

    const thumb =
      article.querySelector('[data-a-target="preview-card-image-link"]') ||
      article.querySelector('[data-a-target="preview-card-thumbnail"]') ||
      article.querySelector('figure') ||
      article;

    const id = '__langBadge';
    if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';

    let el = thumb.querySelector(`.${id}`);
    if (!el) {
      el = document.createElement('div');
      el.className = id;
      el.style.position = 'absolute';
      el.style.top = '8px';
      el.style.right = '8px';
      el.style.padding = '2px 6px';
      el.style.borderRadius = '4px';
      el.style.fontSize = '12px';
      el.style.fontWeight = '700';
      el.style.lineHeight = '16px';
      el.style.background = 'rgb(145,71,255)'; // <-- Badge background
      el.style.color = '#fff';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '3';
      el.textContent = '[??]';
      thumb.appendChild(el);
    }
    el.textContent = `[${langByLogin.get(login) || '??'}]`;
  }

  function annotate(root = document) {
    if (VISUAL_MODE === 'suffix-right') {
      let nodes = root.querySelectorAll(
        'p[data-a-target="preview-card-channel-link"], p[data-test-selector="TitleAndChannel__channelLink"]'
      );
      if (nodes.length === 0) {
        nodes = root.querySelectorAll(
          'a[data-a-target="preview-card-channel-link"], a[data-test-selector="preview-card-channel-link"], a[data-test-selector="TitleAndChannel__channelLink"]'
        );
      }
      nodes.forEach((n) => {
        const login = getLoginFromLink(n);
        if (!login) return;
        ensureRightSuffix(n, login);
      });
    } else {
      const links = root.querySelectorAll(ANY_LINK_SELECTORS);
      links.forEach((a) => {
        const login = getLoginFromLink(a);
        if (!login) return;
        ensureBadge(a, login);
      });
    }
  }

  let raf = null;
  function queueAnnotate() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => annotate(document));
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (!m.addedNodes || !m.addedNodes.length) continue;
      for (const n of m.addedNodes) if (n.nodeType === 1) annotate(n);
    }
  });

  function start() {
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
    queueAnnotate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
