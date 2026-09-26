import domino from "@mixmark-io/domino";
import TurndownService from "turndown";

// ATX headings and fenced code survive truncation and re-quoting better than
// setext underlines and indented blocks, and are what models read most
// reliably.
const turndownService = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndownService.remove("script");
turndownService.remove("style");

// Elements that never carry article content on any page.
const ALWAYS_REMOVED = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"nav",
	"aside",
	"form",
	"dialog",
	"devsite-header",
	"devsite-book-nav",
	"devsite-toc",
	".devsite-sidebar",
	".devsite-banner",
	".devsite-article-meta",
	".devsite-actions",
	".nocontent",
	"[hidden]",
	"[data-nosnippet]",
	"[aria-hidden='true']",
	"[role='banner']",
	"[role='contentinfo']",
	"[role='navigation']",
	".advertisement",
	".cookie-banner",
	".newsletter-signup",
	".social-share",
];

// header and footer are site chrome at page level, but inside an article or
// section they hold the title, byline, and footnotes, which must survive.
const LANDMARK_ONLY = ["header", "footer"];
const CONTENT_CONTAINERS = new Set(["article", "main", "section"]);

const MAIN_CONTENT_SELECTORS = [
	".devsite-article-body",
	"article.main-content",
	"article",
	"main",
	"[role='main']",
	".article-body",
	".entry-content",
	".post-content",
	"#content",
	".content",
];

// A more specific selector wins only when it holds at least this share of the
// best candidate's text. That keeps `article` preferred over a wrapping
// `main`, while a small teaser card cannot beat the real content.
const MIN_SHARE_OF_BEST = 0.5;

const removeAll = (root: ParentNode, selector: string): void => {
	const nodes = root.querySelectorAll(selector);
	for (let index = nodes.length - 1; index >= 0; index--) {
		const node = nodes.item(index);
		node.parentNode?.removeChild(node);
	}
};

const insideContentContainer = (element: Element): boolean => {
	for (
		let parent = element.parentElement;
		parent !== null;
		parent = parent.parentElement
	) {
		if (
			CONTENT_CONTAINERS.has(parent.tagName.toLowerCase()) ||
			parent.getAttribute("role") === "main"
		)
			return true;
	}
	return false;
};

const removeChrome = (document: Document): void => {
	for (const selector of ALWAYS_REMOVED) removeAll(document, selector);
	for (const selector of LANDMARK_ONLY) {
		const nodes = document.querySelectorAll(selector);
		for (let index = nodes.length - 1; index >= 0; index--) {
			const node = nodes.item(index);
			if (!insideContentContainer(node)) node.parentNode?.removeChild(node);
		}
	}
};

const resolveBaseUrl = (document: Document, responseUrl: string): string => {
	const href = document.querySelector("base[href]")?.getAttribute("href");
	if (!href) return responseUrl;
	try {
		return new URL(href, responseUrl).toString();
	} catch {
		return responseUrl;
	}
};

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

const absolutize = (
	value: string,
	baseUrl: string,
	allowed: Set<string>,
): string | undefined => {
	try {
		const absolute = new URL(value, baseUrl);
		return allowed.has(absolute.protocol) ? absolute.toString() : undefined;
	} catch {
		return undefined;
	}
};

// Lazy-loading pages often leave `src` empty and put the real image in
// `data-src` or the first `srcset` candidate. Turndown only reads `src`.
const imageSource = (image: Element): string | null =>
	image.getAttribute("src") ||
	image.getAttribute("data-src") ||
	image.getAttribute("srcset")?.trim().split(/\s+/)[0] ||
	null;

export const makeUrlsAbsolute = (
	document: Document,
	responseUrl: string,
): void => {
	const baseUrl = resolveBaseUrl(document, responseUrl);

	const links = document.querySelectorAll("a[href]");
	for (let index = 0; index < links.length; index++) {
		const link = links.item(index);
		const href = link.getAttribute("href");
		if (!href || href.startsWith("#")) continue;
		const absolute = absolutize(href, baseUrl, LINK_PROTOCOLS);
		if (absolute) link.setAttribute("href", absolute);
		else link.removeAttribute("href");
	}

	const images = document.querySelectorAll("img");
	for (let index = 0; index < images.length; index++) {
		const image = images.item(index);
		const source = imageSource(image);
		const absolute = source
			? absolutize(source, baseUrl, IMAGE_PROTOCOLS)
			: undefined;
		if (absolute) image.setAttribute("src", absolute);
		else image.removeAttribute("src");
	}
};

const contentScore = (element: Element): number => {
	const textLength = (element.textContent ?? "").trim().length;
	let linkLength = 0;
	const links = element.querySelectorAll("a");
	for (let index = 0; index < links.length; index++) {
		linkLength += (links.item(index).textContent ?? "").trim().length;
	}
	// Link text is discounted so navigation-heavy blocks lose to prose.
	return textLength - linkLength * 0.75;
};

export const findMainContent = (document: Document): Element | null => {
	const bestPerSelector: Array<{ element: Element; score: number }> = [];
	for (const selector of MAIN_CONTENT_SELECTORS) {
		const candidates = document.querySelectorAll(selector);
		let best: { element: Element; score: number } | undefined;
		for (let index = 0; index < candidates.length; index++) {
			const element = candidates.item(index);
			const score = contentScore(element);
			if (score > 0 && (!best || score > best.score)) best = { element, score };
		}
		if (best) bestPerSelector.push(best);
	}
	const topScore = Math.max(0, ...bestPerSelector.map(({ score }) => score));
	const chosen = bestPerSelector.find(
		({ score }) => score >= topScore * MIN_SHARE_OF_BEST,
	);
	return chosen?.element ?? document.body;
};

export interface MarkdownResult {
	content: string;
	title?: string;
}

export const convertHtmlToMarkdown = (
	html: string,
	responseUrl: string,
): MarkdownResult => {
	const document = domino.createDocument(html, true);
	const title = document.title.trim() || undefined;
	removeChrome(document);
	makeUrlsAbsolute(document, responseUrl);
	const contentNode = findMainContent(document);
	const htmlToConvert =
		contentNode?.innerHTML || document.body?.innerHTML || html;
	const content = turndownService
		.turndown(htmlToConvert)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return title ? { content, title } : { content };
};

// The title almost always sits in the first few KiB. Scanning a bounded prefix
// avoids building a DOM for a document of up to 32 MiB just to read it.
const TITLE_SCAN_CHARS = 64 * 1024;

export const extractTitle = (html: string): string | undefined => {
	const match = html
		.slice(0, TITLE_SCAN_CHARS)
		.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
	if (!match?.[1]) return undefined;
	// Parsing just the title element decodes entities exactly as a browser
	// would, at negligible cost.
	const document = domino.createDocument(
		`<title>${match[1].replace(/</g, "&lt;")}</title>`,
		true,
	);
	return document.title.trim() || undefined;
};
