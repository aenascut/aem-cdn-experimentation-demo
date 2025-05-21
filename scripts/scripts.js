import {
  buildBlock,
  loadHeader,
  loadFooter,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateTemplateAndTheme,
  waitForFirstImage,
  waitForLCP,
  loadSection,
  loadSections,
  loadCSS,
} from './aem.js';

const LCP_BLOCKS = []; // add your LCP blocks to the list

// Alloy Web SDK
function initWebSDK(path, config) {
  // Preparing the alloy queue
  if (!window.alloy) {
    // eslint-disable-next-line no-underscore-dangle
    (window.__alloyNS ||= []).push('alloy');
    window.alloy = (...args) => new Promise((resolve, reject) => {
      window.setTimeout(() => {
        window.alloy.q.push([resolve, reject, args]);
      });
    });
    window.alloy.q = [];
  }
  // Loading and configuring the websdk
  return new Promise((resolve) => {
    import(path)
      .then(() => window.alloy('configure', config))
      .then(resolve);
  });
}

function initATSDK(path) {
  // Loading and configuring the websdk
  return new Promise((resolve) => {
    import(path)
      .then(resolve);
  });
}

function onDecoratedElement(fn) {
  // Apply propositions to all already decorated blocks/sections
  if (document.querySelector('[data-block-status="loaded"],[data-section-status="loaded"]')) {
    fn();
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.target.tagName === 'BODY'
      || m.target.dataset.sectionStatus === 'loaded'
      || m.target.dataset.blockStatus === 'loaded')) {
      fn();
    }
  });
  // Watch sections and blocks being decorated async
  observer.observe(document.querySelector('main'), {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-block-status', 'data-section-status'],
  });
  // Watch anything else added to the body
  observer.observe(document.querySelector('body'), { childList: true });
}

function toCssSelector(selector) {
  return selector.replace(/(\.\S+)?:eq\((\d+)\)/g, (_, clss, i) => `:nth-child(${Number(i) + 1}${clss ? ` of ${clss})` : ''}`);
}

async function getElementForProposition(proposition) {
  const selector = proposition.data.prehidingSelector
    || toCssSelector(proposition.data.selector);
  return document.querySelector(selector);
}

function applyJsonDecisions(propositions) {
  propositions.forEach((p) => {
    const filterJsonDecisions = (i) => i.schema === 'https://ns.adobe.com/personalization/json-content-item' && Array.isArray(i.data?.content?.payload) && i.data.content?.payload?.length;

    const contentPayload = p.items
      .filter(filterJsonDecisions)
      .flatMap((i) => i.data.content)
      .flatMap((c) => c.payload);
    p.items = p.items.filter((i) => !filterJsonDecisions(i));

    if (Array.isArray(contentPayload) && contentPayload?.length) {
      contentPayload.forEach((c) => {
        const selector = c?.browser?.selector || c.selector;
        const payload = c?.browser?.payload || c.payload;

        if (selector && payload) {
          const el = document.querySelector(selector);
          if (el) {
            el.outerHTML = payload;
          }
        }
      });
    }
  });
}
async function getAndApplyRenderDecisions() {
  // Get the decisions, but don't render them automatically
  // so we can hook up into the AEM EDS page load sequence
  const response = await window.alloy('sendEvent', { renderDecisions: false });
  const { propositions } = response;
  onDecoratedElement(async () => {
    await window.alloy('applyPropositions', { propositions });
    // keep track of propositions that were applied
    propositions.forEach((p) => {
      p.items = p.items.filter((i) => i.schema !== 'https://ns.adobe.com/personalization/dom-action' || !getElementForProposition(i));
    });
    applyJsonDecisions(propositions);
  });

  // Reporting is deferred to avoid long tasks
  window.setTimeout(() => {
    // Report shown decisions
    window.alloy('sendEvent', {
      xdm: {
        eventType: 'decisioning.propositionDisplay',
        _experience: {
          decisioning: { propositions },
        },
      },
    });
  });
}

const searchParams = new URLSearchParams(window.location.search);
if (searchParams.get('implementation') && searchParams.get('implementation') === 'at') {
  window.oddServerSideConfig = {
    preventAlloyImport: true,
    loadAT: true,
  };
}
const serverSideConfig = window.oddServerSideConfig;
const bootstrapedServerSide = serverSideConfig && serverSideConfig.preventAlloyImport;

const alloyLoadedPromise = bootstrapedServerSide ? Promise.resolve() : initWebSDK('./alloy.min.js', {
  datastreamId: 'bdb5cb8a-4496-4abd-8afc-e9396c1b1c27',
  orgId: '82C94E025B2385B40A495E2C@AdobeOrg',
});
  // Always load target
  // if (getMetadata('target')) {
if (!bootstrapedServerSide) {
  alloyLoadedPromise.then(() => getAndApplyRenderDecisions());
}
// }

if (window.oddServerSideConfig && window.oddServerSideConfig.loadAT) {
  window.targetPageParams = () => ({
    at_property: '11e71d11-fc01-4d1e-f157-2783bc9c0e77',
  });

  initATSDK('./at.min.js').then(() => {
    window.adobe.target.getOffers({
      request: {
        execute: {
          pageLoad: {
            parameters: {},
          },
        },
      },
    }).then((data) => {
      const option = data.execute.pageLoad.options.find((opt) => opt?.responseTokens['activity.id'] === '272129');
      const { content } = option ?? {};

      content?.payload?.forEach((c) => {
        const selector = c?.browser?.selector || c.selector;
        const payload = c?.browser?.payload || c.payload;

        if (selector && payload) {
          const el = document.querySelector(selector);
          if (el) {
            el.outerHTML = payload;
          }
        }
      });
    });
  });
}

/**
 * Builds hero block and prepends to main in a new section.
 * @param {Element} main The container element
 */
function buildHeroBlock(main) {
  const h1 = main.querySelector('h1');
  const picture = main.querySelector('picture');
  // eslint-disable-next-line no-bitwise
  if (h1 && picture && (h1.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_PRECEDING)) {
    const section = document.createElement('div');
    section.append(buildBlock('hero', { elems: [picture, h1] }));
    main.prepend(section);
  }
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

function autolinkModals(element) {
  element.addEventListener('click', async (e) => {
    const origin = e.target.closest('a');

    if (origin && origin.href && origin.href.includes('/modals/')) {
      e.preventDefault();
      const { openModal } = await import(`${window.hlx.codeBasePath}/blocks/modal/modal.js`);
      openModal(origin.href);
    }
  });
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    buildHeroBlock(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  // hopefully forward compatible button decoration
  decorateButtons(main);
  decorateIcons(main);
  buildAutoBlocks(main);
  decorateSections(main);
  decorateBlocks(main);
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  decorateTemplateAndTheme();
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    // wait for alloy to finish loading
    await alloyLoadedPromise;
    // show the LCP block in a dedicated frame to reduce TBT
    await new Promise((res) => {
      window.requestAnimationFrame(async () => {
        await waitForLCP(LCP_BLOCKS);
        res();
      });
    });

    document.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  autolinkModals(doc);

  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadHeader(doc.querySelector('header'));
  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  // eslint-disable-next-line import/no-cycle
  window.setTimeout(() => import('./delayed.js'), 3000);
  // load anything that can be postponed to the latest here
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();

if (window.initPropositionsDecisions) {
  onDecoratedElement(() => {
    applyJsonDecisions(window.initPropositionsDecisions);
  });
}
