import {
  marked,
  Renderer,
  Token,
  TokenizerAndRendererExtension,
  Tokens,
} from "marked";
import katex from "katex";
import DOMPurify from "dompurify";
import { Role } from "./definitions";
// Types
type ChatHistoryList = Array<{ role: Role; content: string }>;
// Compile time safety checks for otherwise identical types
type MainShadowGroup = HTMLDivElement & { __brand: "MainShadowGroup" }; // Container for the chat box, the chat icon, and the create thread icon
type ChatBox = HTMLDivElement & { __brand: "ChatBox" };
type ChatIcon = HTMLDivElement & { __brand: "ChatIcon" };

interface BoxData {
  mainShadowGroup: MainShadowGroup; // Parent element containing chatIcon and chatBox
  highlightedText: string; // Text the user highlighted
  surroundingContextText: string; // Surrounding context of the highlighted text
  contextTextNodes: Text[]; // Text nodes for the surrounding context
  messages: { role: Role; content: string }[]; // Chat history
  id: number; // Unique ID for the chat box
  range: Range; // Text range for positioning
  chatBox: ChatBox; // Chat box DOM element
  chatIcon: ChatIcon; // Chat icon DOM element
  highlightManager: HighlightManager; // Manages context text highlight state
  isRequestInProgress: boolean; // Whether a request is currently in progress
  sendBtn: HTMLButtonElement; // Button to send the message
  conversationId: string; // Unique ID for the conversation
}

interface Configuration {
  [key: string]: boolean | number | string; // Index signature for dynamic keys
  boxPlacement: boolean; // Whether custom box placement is enabled
  boxSize: boolean; // Whether custom box size is enabled
  maxResponseWords: number; // Maximum words in the AI response
  modelVersion: string; // AI model version
  gptThreadsApiKey: string; // API key for GPT Threads
  contextWords: number; // Changed from contextLines
  showContextHighlights: boolean;
}

interface MathToken {
  type: string;
  raw: string;
  text: string;
}

// Message schema for content script to background script communication via Chrome runtime port
export interface ContentToBkgMessage {
  type: "OPENAI_QUERY";
  systemPrompt: string;
  prompt: string;
  maxCompletionTokens: number;
  modelVersion: string;
  chatHistoryList: ChatHistoryList;
  conversationId: string;
}

// Message schema for background script to content script communication via Chrome runtime port
export interface BkgToContentMessage {
  content?: string;
  // Indicates error-less completion
  doneWithoutError?: boolean;
  error?: string;
}

// Message schema for properties stored in chrome sync storage
export interface SyncStorage {
  [key: string]: boolean | number | string | undefined;
  boxPlacement?: boolean;
  boxSize?: boolean;
  maxResponseWords?: number;
  modelVersion?: string;
  extensionToggle?: boolean;
  contextWords?: number;
  showContextHighlights?: boolean;
}

interface ChatWidthHeight {
  width: number;
  height: number;
}

// The cached x (left) offset for the chat box. Only includes left since webpages typically have empty left or right bars
// which are convenient to place chat boxes in.
// This currently assumes all chat boxes are placed relative to the same parent element.
interface BoxCachedPosition {
  x: number; // Default absolute X (left) position relative to the parent element
}

// Constants
// Note: For the container objects to show below website items like header bars,
// this assumes the website sets a higher z-index for such elements than the values below.
// Thread icons to create new chats should always be on top
const THREADS_ICON_ZINDEX = "1002";
// The currently selected chatbox will have this Z Index
// Should scroll behind headers, website headers typically have z-index 10+
const TOP_CHATBOX_ZINDEX = "1001";
// Default Z index for GPT Threads components
// Previously a much smaller number, like 8, but some side bars like on StackOverflow have
// very high Z Index. This makes the chat box typically scroll above the header bar of some sites
// like ChatGPT, but this is probably better than being below other sites' content.
const BASE_ZINDEX = "1000";
// Approximately 2 tokens per word
const TOKENS_TO_WORDS = 2;
// Typical per line height for the input area (pixels), same as ChatGPT
const INPUT_LINE_HEIGHT = 24;
// Max height for the input area (5 lines)
const MAX_INPUT_HEIGHT = 5 * INPUT_LINE_HEIGHT;

// Store all chat boxes
let nextChatBoxId = 0;
// Every chat box has a thread icon
let chatBoxData: BoxData[] = [];
// Each thread icon can be associated with a chat box, but may be standalone
// if it is not clicked to open a chat box
let threadShadowHosts: MainShadowGroup[] = [];
// Width and height of any chat box, may change when resized if user configures box size caching
// Useful for starting new chat boxes with the same dimensions as the user's past preference
let startingChatWH: ChatWidthHeight = {
  width: 350,
  height: 400,
};
let currentChatWH: ChatWidthHeight = { ...startingChatWH };
// Cached box absolute X position
let boxCachedPosition: BoxCachedPosition | null = null;

// Metadata configuration for the chat box, including model version and limits
// Will be stored and retrieved from chrome storage
let configuration: Configuration = {
  boxPlacement: false,
  boxSize: false,
  maxResponseWords: 150,
  modelVersion: "gpt-4o",
  gptThreadsApiKey: "",
  extensionToggle: true,
  // Typically, some local context is useful
  contextWords: 100,
  showContextHighlights: false,
};

const configKeys: (keyof SyncStorage & keyof Configuration)[] = [
  "boxPlacement",
  "boxSize",
  "maxResponseWords",
  "modelVersion",
  "extensionToggle",
  "contextWords", // Changed from contextLines
  "showContextHighlights",
];

class HighlightManager {
  private range: Range;
  private contextRanges: Range[] = [];

  private static nonSelectedHighlights = new Highlight();
  private static selectedHighlights = new Highlight();
  private static contextHighlights = new Highlight();

  constructor(range: Range) {
    if (typeof Highlight === "function") {
      this.range = range;

      // Make the current range the selected range
      this.markAsSelected();

      // Register the highlights with the CSS Highlight API
      const registry = CSS.highlights;
      if (!registry.has("gptthreads-non-selected")) {
        registry.set(
          "gptthreads-non-selected",
          HighlightManager.nonSelectedHighlights
        );
      }
      if (!registry.has("gptthreads-selected")) {
        registry.set(
          "gptthreads-selected",
          HighlightManager.selectedHighlights
        );
      }
      if (!registry.has("gptthreads-context")) {
        registry.set("gptthreads-context", HighlightManager.contextHighlights);
      }
    } else {
      throw new Error("Web Highlight API is not supported in this browser.");
    }
  }

  setContextRanges(textNodes: Text[]) {
    // Clear any existing context highlights
    this.clearContextHighlights();

    // Don't show context highlights if disabled
    if (!configuration.showContextHighlights) return;

    // Create ranges for context text nodes
    for (const node of textNodes) {
      if (this.range.intersectsNode(node)) {
        // If this node intersects with the selection, we need to create two context ranges:
        // one before and one after the selection
        const nodeRange = new Range();
        nodeRange.selectNodeContents(node);

        // Get the intersection points between the node range and selection range
        const nodeStart = nodeRange.startOffset;
        const nodeEnd = nodeRange.endOffset;
        const selectionStart =
          this.range.startContainer === node
            ? this.range.startOffset
            : nodeStart;
        const selectionEnd =
          this.range.endContainer === node ? this.range.endOffset : nodeEnd;

        // Create range before the selection if needed
        if (nodeStart < selectionStart) {
          const beforeRange = new Range();
          beforeRange.setStart(node, nodeStart);
          beforeRange.setEnd(node, selectionStart);
          this.contextRanges.push(beforeRange);
          HighlightManager.contextHighlights.add(beforeRange);
        }

        // Create range after the selection if needed
        if (selectionEnd < nodeEnd) {
          const afterRange = new Range();
          afterRange.setStart(node, selectionEnd);
          afterRange.setEnd(node, nodeEnd);
          this.contextRanges.push(afterRange);
          HighlightManager.contextHighlights.add(afterRange);
        }
      } else {
        // Node doesn't intersect with selection, highlight the whole node
        const range = new Range();
        range.selectNodeContents(node);
        this.contextRanges.push(range);
        HighlightManager.contextHighlights.add(range);
      }
    }

    // Ensure the selected range stays highlighted
    this.markAsSelected();
  }

  clearContextHighlights() {
    this.contextRanges.forEach((range) => {
      HighlightManager.contextHighlights.delete(range);
    });
    this.contextRanges = [];
  }

  removeHighlight() {
    HighlightManager.nonSelectedHighlights.delete(this.range);
    HighlightManager.selectedHighlights.delete(this.range);
    this.clearContextHighlights();
  }

  markAsSelected() {
    // Mark all other ranges as non-selected
    for (const range of HighlightManager.selectedHighlights) {
      HighlightManager.nonSelectedHighlights.add(range);
      HighlightManager.selectedHighlights.delete(range);
    }

    // Highlight has a Set() interface, so redundant adds and deletes are idempotent
    HighlightManager.selectedHighlights.add(this.range);
    HighlightManager.nonSelectedHighlights.delete(this.range);
  }

  /**
   * Marks the range as non-selected (e.g., on hover out).
   */
  markAsNonSelected() {
    HighlightManager.selectedHighlights.delete(this.range);
    HighlightManager.nonSelectedHighlights.add(this.range);
  }
}

class MarkdownProcessor {
  // Singleton, `MarkdownProcessor` initializes `marked` for the content script.
  private static instance: MarkdownProcessor | null = null;
  private inlineMathExtension: TokenizerAndRendererExtension = {
    name: "inlineMath",
    level: "inline",
    start: (src: string): number => {
      return src.indexOf("\\(");
    },
    tokenizer: (src: string, tokens: Token[]): MathToken | undefined => {
      const rule = /^\\\(([\s\S]+?)\\\)/;
      const match = rule.exec(src);
      if (match) {
        return {
          type: "inlineMath",
          raw: match[0],
          text: match[1].trim(),
        };
      }
      return undefined;
    },
    renderer: (token: any): string => {
      try {
        // Directly render the math using KaTeX.
        return katex.renderToString(token.text, { output: "mathml" });
      } catch (error) {
        console.error("Error rendering inline math:", error);
        // If rendering fails, fall back to the raw LaTeX.
        return `${token.text}`;
      }
    },
  };

  private blockMathExtension: TokenizerAndRendererExtension = {
    name: "blockMath",
    level: "block",
    start: (src: string): number => {
      return src.indexOf("\\[");
    },
    tokenizer: (src: string, tokens: Token[]): MathToken | undefined => {
      const rule = /^\\\[([\s\S]+?)\\\]\n?/;
      const match = rule.exec(src);
      if (match) {
        return {
          type: "blockMath",
          raw: match[0],
          text: match[1].trim(),
        };
      }
      return undefined;
    },
    renderer: (token: any): string => {
      try {
        // Directly render block math using KaTeX.
        return katex.renderToString(token.text, {
          displayMode: true,
          output: "mathml",
        });
      } catch (error) {
        console.error("Error rendering block math:", error);
        return `${token.text}`;
      }
    },
  };

  private customRenderer: Renderer = new marked.Renderer();

  private constructor() {
    // Overide code block rendering, marked by default will escape the text.
    // We will apply global escapes to all characters. Not disabling this would
    // cause double escapes in code blocks!
    // Concretely,
    // ```html
    // <div>
    //   <p>Hello, world!</p>
    // </div>
    // ```
    // will become this after one escape (desirable)
    // ```html
    // &lt;div&gt;
    //   &lt;p&gt;Hello, world!&lt;/p&gt;
    // &lt;/div&gt;
    // ```
    // which will become this after two escapes (not desirable)
    // ```html
    // &amp;lt;div&amp;gt;
    //   &amp;lt;p&amp;gt;Hello, world!&amp;lt;/p&amp;gt;
    // &amp;lt;/div&amp;gt;
    // ```
    this.customRenderer.code = (codeToken: Tokens.Code): string => {
      // Simply return the raw code wrapped in <pre><code>
      return `<pre><code>${codeToken.text}</code></pre>`;
    };

    this.customRenderer.codespan = (codespanToken: Tokens.Codespan): string => {
      return `<code>${codespanToken.text}</code>`;
    };

    marked.use({ renderer: this.customRenderer });

    marked.use({
      extensions: [this.inlineMathExtension, this.blockMathExtension],
      hooks: {
        preprocess: MarkdownProcessor.markedPreProcess,
        postprocess: MarkdownProcessor.markedPostProcess,
      },
    });
  }

  public static getInstance(): MarkdownProcessor {
    if (!MarkdownProcessor.instance) {
      MarkdownProcessor.instance = new MarkdownProcessor();
    }
    return MarkdownProcessor.instance;
  }

  private static markedPreProcess(html: string): string {
    return html
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/'/g, "&apos;")
      .replace(/"/g, "&quot;");
  }

  private static markedPostProcess(html: string): string {
    return DOMPurify.sanitize(html);
  }

  public parse(markdown: string): string {
    return marked.parse(markdown, { async: false });
  }
}

const markdownProcessor = MarkdownProcessor.getInstance();

// Remove prior chat boxes and thread icons when the user clicks outside of them
// This should occur on `mousedown` so new elements can be created on `mouseup`.
// Note that JS handles `mousedown -> mouseup -> click` events
document.addEventListener("mousedown", (event) => {
  // Thread icons if the user clicks outside of them.
  // Note that chat boxes are not removed on clicking outside such that users
  // can have multiple simultaneous open chats. Chats should be explicitly closed
  // via the close button.
  threadShadowHosts.filter((shadowHost) => {
    if (event.target instanceof Node) {
      const clickedOnThisIcon = shadowHost.contains(event.target);
      if (clickedOnThisIcon) {
        return true;
      }
    }
    // Remove this icon if it was not clicked on, meaning user clicked outside of it
    shadowHost.remove();
    return false;
  });
});

// When the user finishes selecting text (click), show a threads icon if text selected
// Only create on `click` and not `mouseup` because prior selections are only cleared on `click`.
// This means when a user moves away from a selection and clicks again, the selection
// will be empty so another threads icon will not be created.
document.addEventListener("click", async (event: MouseEvent) => {
  const selection = window.getSelection();
  if (!selection) return;

  if (configuration.extensionToggle === false) return;

  const highlightedText = selection.toString().trim();
  console.debug("Highlighted text:", highlightedText);
  if (highlightedText.length === 0) return;

  // on some sites such as GitHub when viewing elements such as TextArea with default text (e.g. in preview of code files)
  // the window selection gives a 0 width range (possibly because TextArea handles selections internally and to the `document`
  // the selection is simply a cursor and is empty). Currently, using "surrounding context" on these sites is not supported.
  const range = selection.getRangeAt(0);

  // Create a threads icon that user can click to open the chat box
  await createThreadsIcon(range, highlightedText, event);
});

/**
 * Create a small "threads" icon next to the highlighted text.
 * Clicking this icon will then create and show the chat box.
 * @param {Range} range - The highlighted text range.
 * @param {string} highlightedText
 * @param {MouseEvent} event - The mouse event for positioning the icon.
 */
async function createThreadsIcon(
  range: Range,
  highlightedText: string,
  event: MouseEvent
) {
  const mainShadowGroup: MainShadowGroup = await createMainShadowGroup();
  document.body.appendChild(mainShadowGroup);
  const padding = 10;
  const top = event.clientY + window.scrollY + padding;
  const left = event.clientX + window.scrollX;
  mainShadowGroup.style.top = `${Math.max(0, top)}px`; // a bit above the text
  mainShadowGroup.style.left = `${left}px`;
  mainShadowGroup.style.zIndex = THREADS_ICON_ZINDEX;
  mainShadowGroup.style.position = "absolute";

  const threadsIcon = document.createElement("div");
  threadsIcon.classList.add("gptthreads-threads-icon");
  threadsIcon.title = "Start a thread with GPT about this";

  // Create an img element and set the src to your SVG file path
  const imgIcon = document.createElement("img");
  imgIcon.src = chrome.runtime.getURL("src/assets/activeThread.svg");
  imgIcon.alt = "Start New Thread";

  // Append the img to the threadsIcon div
  threadsIcon.appendChild(imgIcon);

  console.debug("Threads icon created at:", event.clientX, event.clientY);
  console.debug("Threads icon:", threadsIcon);
  mainShadowGroup.shadowRoot?.appendChild(threadsIcon);

  threadShadowHosts.push(mainShadowGroup);

  threadsIcon.addEventListener("click", async () => {
    // Remove the icon shadow host once clicked
    mainShadowGroup.remove();
    // Clear the user's text selection
    // Sometimes the user text selection persists after the threadIcon click
    // which can cause more threadIcons to appear for the highlighted text.
    clearTextSelection();
    // Now create the chat box. Done after clearing the selection and removing the thread icon so
    // they are immediately processed by the call stack. Otherwise, another thread icon may appear
    // because the selection is not cleared.
    await createChatBox(range, highlightedText);
  });
}

/**
 * Clear the user's text selection.
 */
function clearTextSelection() {
  const selection = window.getSelection();
  if (selection && selection.removeAllRanges) {
    selection.removeAllRanges(); // Clear the selection
  }
}

/**
 * Truncate text to at most maxLines and maxChars.
 * If longer, show first half of maxLines-1 lines, then '...',
 * then last half of maxLines-1 lines.
 *
 * @param {string} text
 * @param {number} maxLines - Maximum number of lines to display
 * @param {number} maxChars - Maximum number of characters to display
 */
function getTruncatedText(
  text: string,
  maxLines: number = 5,
  maxChars: number = 200
): string {
  if (text.length <= maxChars && text.split("\n").length <= maxLines) {
    return text;
  }

  const lines = text.split("\n");
  if (lines.length > maxLines) {
    // reserve one line for "..."
    const previewLines = Math.floor((maxLines - 1) / 2);
    const truncatedLines = [
      ...lines.slice(0, previewLines),
      "...",
      ...lines.slice(-previewLines),
    ].join("\n");
    if (truncatedLines.length <= maxChars) {
      return truncatedLines;
    }
  }

  // Reserve 3 characters for "..."
  const half = Math.floor((maxChars - 3) / 2);
  const start = text.slice(0, half);
  const end = text.slice(-half);
  return start + "..." + end;
}

/**
 * Creates branded MainShadowGroup element as a Shadow DOM host.
 * Also injects the main style CSS file.
 * @returns {MainShadowGroup}
 */
async function createMainShadowGroup(): Promise<MainShadowGroup> {
  const shadowHost = document.createElement("div") as HTMLDivElement;
  (shadowHost as MainShadowGroup).__brand = "MainShadowGroup";

  // Create and attach shadow root
  const shadowRoot = shadowHost.attachShadow({ mode: "open" });

  // Fetch the CSS file content and inject it as a <style> element
  const cssURL = chrome.runtime.getURL("src/chatBoxStyles.css");
  const cssContent = await fetch(cssURL).then((response) => response.text());
  const styleTag = document.createElement("style");
  styleTag.textContent = cssContent;

  // Append the style tag to the shadow root
  shadowRoot.appendChild(styleTag);

  return shadowHost as MainShadowGroup;
}

/**
 * Creates branded ChatBox element.
 * @returns {ChatBox}
 */
function createChatBoxElement(): ChatBox {
  const element = document.createElement("div") as HTMLDivElement;
  (element as ChatBox).__brand = "ChatBox"; // Add brand
  return element as ChatBox;
}

/**
 * Creates branded ChatIcon element.
 * @returns {ChatIcon}
 */
function createChatIconElement(): ChatIcon {
  const element = document.createElement("div") as HTMLDivElement;
  (element as ChatIcon).__brand = "ChatIcon"; // Add brand
  return element as ChatIcon;
}

// Modified createChatBox function
async function createChatBox(range: Range, highlightedText: string) {
  const thisChatBoxId = nextChatBoxId++;

  // Use CSS highlight API for highlighting
  const highlightManager = new HighlightManager(range);

  const chatBox: ChatBox = createChatBoxElement();
  chatBox.classList.add("gptthreads-container");
  chatBox.id = `gptthreads-container-${thisChatBoxId}`;

  // If user removes toggle on cached box size, then revert to default size
  if (!configuration.boxSize) {
    currentChatWH = { ...startingChatWH };
  }

  chatBox.style.height = `${currentChatWH.height}px`;
  chatBox.style.width = `${currentChatWH.width}px`;

  const header = document.createElement("div");
  header.classList.add("gptthreads-header");
  header.textContent = "GPT Thread";

  const headerBtns = document.createElement("div");
  headerBtns.classList.add("gptthreads-header-btns");

  const hideBtn = document.createElement("button");
  hideBtn.textContent = "–";
  hideBtn.classList.add("gptthreads-close");
  hideBtn.title = "Hide this chat box";
  hideBtn.addEventListener("click", (e) => {
    highlightManager.markAsNonSelected();
    highlightManager.clearContextHighlights();
    collapseChatBox(chatBox);
    // Stop event from bubbling up to the main shadow group, which would bring it to the front
    // and cause the highlight to briefly show again.
    e.stopImmediatePropagation();
  });
  hideBtn.addEventListener("mousedown", (e) => {
    // Stop event from bubbling up to the main shadow group, which would bring it to the front
    // and cause the highlight to briefly show again.
    e.stopImmediatePropagation();
  });
  headerBtns.appendChild(hideBtn);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✖";
  closeBtn.classList.add("gptthreads-close");
  closeBtn.title = "Close this chat box";
  closeBtn.addEventListener("click", () => {
    removeChatBox(chatBox);
  });
  headerBtns.appendChild(closeBtn);

  header.appendChild(headerBtns);
  chatBox.appendChild(header);

  // Add chat `Context` to the top of the chat box
  const contextDiv = document.createElement("div");
  contextDiv.classList.add("gptthreads-context-container");
  const contextText = document.createElement("span");
  contextText.classList.add("gptthreads-context");

  contextText.textContent = getTruncatedText(highlightedText);

  contextDiv.appendChild(document.createTextNode("Focused Text: "));
  contextDiv.appendChild(contextText);
  chatBox.appendChild(contextDiv);

  makeResizable(chatBox);

  const chatHistoryDivs = document.createElement("div");
  chatHistoryDivs.classList.add("gptthreads-history");
  chatBox.appendChild(chatHistoryDivs);

  // Contains [{role: "user"|"assistant"|"system", content: "message"}]
  const chatHistoryList: ChatHistoryList = [];

  const userInputArea = document.createElement("div");
  userInputArea.classList.add("gptthreads-input-container");

  const input = document.createElement("textarea");
  input.placeholder = "Message ChatGPT";
  userInputArea.appendChild(input);
  input.style.lineHeight = `${INPUT_LINE_HEIGHT}px`;
  input.style.minHeight = `${INPUT_LINE_HEIGHT}px`;
  input.style.maxHeight = `${MAX_INPUT_HEIGHT}px`;

  // Auto expand the text area, limit expansion to a given number of lines
  input.addEventListener("input", function () {
    input.style.height = "auto";
    // Hide the overflow to prevent the scroll height from being affected by the borders
    input.style.overflow = "hidden";
    // Scroll height does not include the borders
    // Setting height to scroll height alone would reduce total content height by the top + bottom border width
    const computedStyle = window.getComputedStyle(input);
    const borderTop = parseFloat(computedStyle.borderTopWidth);
    const borderBottom = parseFloat(computedStyle.borderBottomWidth);
    input.style.height = `${input.scrollHeight + borderTop + borderBottom}px`;
    // Restore the scroll bar
    input.style.overflow = "auto";
  });

  // Add event listener to prevent page shortcuts when input is focused
  // e.g. ome pages use "s" as a shortcut to jump to the search bar.
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    event.stopPropagation();
  });

  const sendBtnContainer = document.createElement("div");
  sendBtnContainer.classList.add("gptthreads-send-button-container");

  const sendIcon = document.createElement("img");
  sendIcon.src = chrome.runtime.getURL("src/assets/send.svg");
  sendIcon.alt = "Send";
  const sendBtn = document.createElement("button");
  sendBtn.appendChild(sendIcon);
  sendBtnContainer.appendChild(sendBtn);

  userInputArea.appendChild(sendBtnContainer);
  chatBox.appendChild(userInputArea);

  const chatIcon = createChatIconElement();
  chatIcon.title = "Show existing GPT Thread";
  chatIcon.classList.add("gptthreads-threads-icon");
  chatIcon.style.display = "none";
  // Place chatIcon in the middle horizontally relative to the chatBox
  chatIcon.style.left = `${currentChatWH.width / 2}px`;

  const chatIconImg = document.createElement("img");
  chatIconImg.src = chrome.runtime.getURL("src/assets/passiveThread.svg");
  chatIconImg.alt = "GPT Thread";
  chatIcon.appendChild(chatIconImg);

  chatIconImg.addEventListener("dragstart", (e) => {
    // Default image dragging creates a low opacity image and drags with cursor
    e.preventDefault();
  });

  // Groups the chat icon and the chat box. Primary container which positions inner elements.
  const mainShadowGroup: MainShadowGroup = await createMainShadowGroup();
  // Shadow root is always created in open mode
  const mainShadowRoot = mainShadowGroup.shadowRoot!;
  mainShadowGroup.classList.add("gptthreads-group");
  mainShadowRoot.appendChild(chatIcon);
  mainShadowRoot.appendChild(chatBox);

  // Show otherwise hidden absolute positioned elements, like the open chat icon
  mainShadowGroup.style.overflow = "visible";
  mainShadowGroup.style.zIndex = TOP_CHATBOX_ZINDEX;
  mainShadowGroup.addEventListener("mousedown", () =>
    bringGroupToFront(mainShadowGroup)
  );
  makeDraggable(mainShadowGroup, header);
  // Event handlers are fired in the order they are registered.
  // Important that this is called before other event listers are added to chatIcon
  // so those event listeners are called afterward. `makeDraggable` will treat clicks and drags
  // of the chat icon as repositioning the chat icon instead of clicks to open the chat box.
  // Putting drag event handlers first can prevent the chat box from opening.
  makeDraggable(mainShadowGroup, chatIcon);

  // Find a parent element that takes up at least half of the screen height
  // Heuristic to find a parent element that is large enough to display the text box,
  // but keeps the text box in the same element flow as the highlighted text.
  const containerElement = findParentWithMaxHeight(range);

  if (containerElement) {
    containerElement.style.position = "relative";
    containerElement.appendChild(mainShadowGroup);
  } else {
    console.warn(
      "Could not find a suitable parent element for the chat container."
    );
    document.body.appendChild(mainShadowGroup);
  }
  // After mounting, focus the input
  input.focus({ preventScroll: true });
  bringGroupToFront(mainShadowGroup);

  // Handle hover events for switching highlight states
  let isClickInProgress = false;
  chatIcon.addEventListener("mouseover", () => {
    highlightManager.markAsSelected();
  });

  chatIcon.addEventListener("mouseout", () => {
    // Do not change the highlight if a click is in progress
    if (isClickInProgress) return;
    highlightManager.markAsNonSelected();
    highlightManager.clearContextHighlights();
  });

  chatIcon.addEventListener("click", () => {
    isClickInProgress = true;
    chatIcon.style.display = "none";
    chatBox.style.display = "flex";
    bringGroupToFront(mainShadowGroup);
    // On showing the chat, bring highlight to front
    highlightManager.markAsSelected();
    highlightManager.setContextRanges(boxData.contextTextNodes);
    // A workaround to not trigger mouseout event when clicking the chat icon, which causes the icon to disappear
    setTimeout(() => (isClickInProgress = false), 100);
    setTimeout(() => {
      const inputElement = chatBox.querySelector("textarea");
      if (inputElement) {
        inputElement.focus({ preventScroll: true });
      }
    }, 0);
  });

  // Get surrounding context if enabled
  const { surroundingContextText, contextTextNodes } =
    configuration.contextWords > 0
      ? getSurroundingContext(
          range,
          highlightManager,
          configuration.contextWords
        )
      : { surroundingContextText: "", contextTextNodes: [] };
  const conversationId = crypto.randomUUID();
  let boxData: BoxData = {
    mainShadowGroup: mainShadowGroup,
    highlightedText: highlightedText,
    surroundingContextText: surroundingContextText,
    contextTextNodes: contextTextNodes,
    messages: [],
    id: thisChatBoxId,
    range: range,
    chatBox: chatBox,
    chatIcon: chatIcon,
    highlightManager: highlightManager,
    isRequestInProgress: false,
    sendBtn: sendBtn,
    conversationId: conversationId,
  };
  chatBoxData.push(boxData);

  input.addEventListener("keypress", function (event: KeyboardEvent) {
    // Stop the event from bubbling up to the webpage
    event.stopPropagation();

    if (event.key === "Enter" && !event.shiftKey) {
      // Enter does not create a new line, but sends the message
      event.preventDefault();
      // Do not allow concurrent requests for a given chat box
      if (boxData.isRequestInProgress) return;
      sendMessage(
        input,
        chatHistoryDivs,
        chatHistoryList,
        highlightedText,
        configuration.maxResponseWords,
        configuration.modelVersion,
        boxData
      );
    }
  });

  sendBtn.addEventListener("click", () => {
    // Do not allow concurrent requests for a given chat box
    if (boxData.isRequestInProgress) return;
    sendMessage(
      input,
      chatHistoryDivs,
      chatHistoryList,
      highlightedText,
      configuration.maxResponseWords,
      configuration.modelVersion,
      boxData
    );
  });

  setInitialChatBoxPosition(boxData);
}

/**
 * Find the parent element with maximum height that contains the given range
 * @param {Range} range
 * @returns {HTMLElement} The parent element with maximum height.
 */
function findParentWithMaxHeight(range: Range): HTMLElement {
  let candidate = range.commonAncestorContainer;
  let maxHeightParent = candidate as HTMLElement;
  // If the first node is a TEXT_NODE, start with its parent element
  if (candidate.nodeType === Node.TEXT_NODE && candidate.parentElement) {
    candidate = candidate.parentElement;
  }

  while (candidate && candidate !== document.body) {
    if (candidate.nodeType === Node.ELEMENT_NODE) {
      // The `Node` is a `HTMLElement`
      const element = candidate as HTMLElement;
      const rect = element.getBoundingClientRect();
      // If the maxHeightParent has no scroll height (e.g. inline span element),
      // replace with the parent element
      if (
        maxHeightParent.scrollHeight === undefined ||
        rect.height >= maxHeightParent.scrollHeight
      ) {
        maxHeightParent = element;
      }
    }

    if (!candidate.parentElement) break;
    candidate = candidate.parentElement;
  }
  if (maxHeightParent.scrollHeight === undefined) {
    maxHeightParent = document.body;
  }
  return maxHeightParent;
}

/**
 * Get surrounding context for the highlighted text
 * @param range The range containing the highlighted text
 * @param contextWords Number of words to get above and below
 * @returns The surrounding context text
 */
function getSurroundingContext(
  range: Range,
  highlightManager: HighlightManager,
  contextWords: number
): { surroundingContextText: string; contextTextNodes: Text[] } {
  if (contextWords <= 0)
    return { surroundingContextText: "", contextTextNodes: [] };

  // Function to get words from text
  const getWords = (text: string): string[] => {
    const words = text.trim().split(/\s+/);
    // Remove empty strings
    // e.g. `"\n"` is split into `[""]` which otherwise looks like 1 word
    return words.filter((word) => word.length > 0);
  };

  // Collect text nodes from the given node up to the given depth until the nodes
  // have text length of at least `contextWords`
  function collectTextNodes(
    node: Node,
    depth: number,
    contextWords: number
  ): Text[] {
    // Contains text nodes in order
    let textNodes: Text[] = nodeToTextNodes(node);

    // Collect text nodes from all previous siblings
    for (
      let sibling = node.previousSibling;
      sibling;
      sibling = sibling.previousSibling
    ) {
      // Previous siblings are added first to maintain order
      textNodes = nodeToTextNodes(sibling).concat(textNodes);
    }

    // Collect text nodes from all next siblings
    for (
      let sibling = node.nextSibling;
      sibling;
      sibling = sibling.nextSibling
    ) {
      textNodes = textNodes.concat(nodeToTextNodes(sibling));
    }
    // Optionally, if additional context is needed, restart another layer up the DOM tree.
    const currContextWords = textNodes.reduce((acc, curr) => {
      return acc + getWords(curr.textContent || "").length;
    }, 0);
    if (node.parentNode && depth > 1 && currContextWords < contextWords) {
      textNodes = collectTextNodes(node.parentNode, depth - 1, contextWords);
    }

    return textNodes;
  }

  // Process a node by:
  // - returning the node itself if it's a text node
  // - or using a TreeWalker to return all descendant text nodes if it's an element.
  function nodeToTextNodes(node: Node): Text[] {
    if (node.nodeType === Node.TEXT_NODE) {
      return [node as Text];
    } else {
      const texts: Text[] = [];
      const walker = document.createTreeWalker(
        node,
        NodeFilter.SHOW_TEXT,
        null
      );
      let textNode = walker.nextNode();
      while (textNode) {
        texts.push(textNode as Text);
        textNode = walker.nextNode();
      }
      return texts;
    }
  }

  function getText(textNodeArr: Text[]): string {
    return textNodeArr.map((n) => n.textContent?.trim()).join(" ");
  }

  // Find the number `n` (`expansion`) such that the range of nodes from [pivotIndex - n, pivotIndex + n]
  // contains the maximum number of words that is `<= contextWords`.
  // More specifically, let `topIdx = min(pivotIndex + n, textNodes.length - 1)` and
  // `bottomIdx = max(pivotIndex - n, 0)`. Then, the nodes from `textNodes[bottomIdx]` to
  // `textNodes[topIdx]` are the candidate nodes and the number of words they contain is
  // the candidate word count.
  // `n` is found via binary search since `TextNodes` could be deeply nested and be 1000s of nodes.
  function findMaxExpansion(
    textNodes: Text[],
    pivotIndex: number,
    contextWords: number,
    getWords: (text: string) => string[],
    getText: (nodes: Text[]) => string
  ): {
    expansion: number;
    contextTextNodes: Text[];
    contextWordCount: number;
  } {
    let maxExpansion = Math.max(pivotIndex, textNodes.length - pivotIndex);
    let low = 0;
    let high = maxExpansion;
    let mid = Math.floor((low + high) / 2);
    let bestExpansion = 0;
    let bestCandidateNodes = [textNodes[pivotIndex]];
    let bestWordCount = getWords(getText(bestCandidateNodes)).length;
    while (low < high) {
      const left = Math.max(0, pivotIndex - mid);
      const right = Math.min(textNodes.length - 1, pivotIndex + mid);
      const candidateNodes = textNodes.slice(left, right);
      const candidateWordCount = getWords(getText(candidateNodes)).length;
      if (candidateWordCount <= contextWords) {
        // found better expansion (guaranteed since expansion is larger), store and try to expand more
        bestExpansion = mid;
        bestCandidateNodes = candidateNodes;
        bestWordCount = candidateWordCount;
        low = mid + 1;
      } else {
        // too large, try to expand less
        high = mid;
      }
      mid = Math.floor((low + high) / 2);
    }
    return {
      expansion: bestExpansion,
      contextTextNodes: bestCandidateNodes,
      contextWordCount: bestWordCount,
    };
  }

  // Collect all relevant text nodes
  const textNodes = collectTextNodes(
    range.commonAncestorContainer,
    // Some sites, like news sites, have deeply nested nodes
    20,
    contextWords
  );
  // Expand around the text node that contains the highlighted text
  // until the number of context words is reached, or we run out of text nodes
  const highlightedIndices: number[] = textNodes
    .map((node, idx) => (range.intersectsNode(node) ? idx : -1))
    .filter((idx) => idx !== -1);
  if (highlightedIndices.length === 0) {
    console.warn("No text nodes intersect the highlighted range.");
    return { surroundingContextText: "", contextTextNodes: [] };
  }
  const pivotIdx =
    highlightedIndices[Math.floor(highlightedIndices.length / 2)];
  const { expansion, contextTextNodes, contextWordCount } = findMaxExpansion(
    textNodes,
    pivotIdx,
    contextWords,
    getWords,
    getText
  );

  // After finding the context text nodes, highlight them
  highlightManager.setContextRanges(contextTextNodes);

  const surroundingContextText: string = getText(contextTextNodes);
  return { surroundingContextText, contextTextNodes };
}

/**
 * Send a message to the assistant and append the response to the chat history.
 * @param {HTMLTextAreaElement} input - The input element containing the user query.
 * @param {HTMLDivElement} chatHistoryDivs - The div containing chat history messages.
 * @param {Array} chatHistoryList - The list of chat history messages.
 * @param {string} highlightedText - The highlighted text for context.
 * @param {number} maxResponseWords - The maximum number of words for the response.
 * @param {string} modelVersion - The model version to use for the response.
 * @param {BoxData} boxData - The data for the affected chat box.
 */
function sendMessage(
  input: HTMLTextAreaElement,
  chatHistoryDivs: HTMLDivElement,
  chatHistoryList: ChatHistoryList,
  highlightedText: string,
  maxResponseWords: number,
  modelVersion: string,
  boxData: BoxData
) {
  const userQuery = input.value.trim();
  if (userQuery.length > 0) {
    appendMessageDiv(chatHistoryDivs, Role.User, userQuery);
    input.value = "";
    // Reset textarea height to minimum
    input.style.height = "auto";

    const surroundingContextText = boxData.surroundingContextText;
    // Update prompt to include surrounding context
    const systemPrompt = surroundingContextText
      ? `Given this focused text: "${highlightedText}", with surrounding context: "${surroundingContextText}". Provide a helpful answer in at most "${maxResponseWords}" words.`
      : `Given this focused text: "${highlightedText}". Provide a helpful answer in at most "${maxResponseWords}" words.`;
    const prompt = userQuery;

    console.debug("Sending message to assistant:", prompt);
    boxData.isRequestInProgress = true;
    boxData.sendBtn.disabled = true;
    boxData.sendBtn.classList.add("disabled");

    const assistantMessageDiv = appendMessageDiv(
      chatHistoryDivs,
      Role.Assistant,
      ""
    );
    assistantMessageDiv.classList.add("waiting-indicator");
    assistantMessageDiv.innerHTML =
      "<span>.</span><span>.</span><span>.</span>";
    const port: chrome.runtime.Port = chrome.runtime.connect({
      name: "openai_stream",
    });

    const messageToBkg: ContentToBkgMessage = {
      type: "OPENAI_QUERY",
      systemPrompt,
      prompt,
      maxCompletionTokens: maxResponseWords * TOKENS_TO_WORDS,
      modelVersion,
      chatHistoryList: chatHistoryList,
      conversationId: boxData.conversationId,
    };

    let isFirst = true;
    let assistantMessage = "";
    port.postMessage(messageToBkg);
    port.onMessage.addListener((response: BkgToContentMessage) => {
      // Always remove the waiting indicator, whether the request was successful or not
      // It will be replaced with the actual response or error message
      if (isFirst) {
        assistantMessageDiv.classList.remove("waiting-indicator");
        assistantMessageDiv.innerText = "";
      }

      if (response.error) {
        console.error("Error:", response.error);
        assistantMessageDiv.innerText = response.error;
      } else if (response.doneWithoutError) {
        // If the request was successful, append message to history after receiving response so the user prompt is not included
        // twice, once in history and once in current query.
        appendMessageList(chatHistoryList, Role.User, userQuery);
        appendMessageList(chatHistoryList, Role.Assistant, assistantMessage);
      } else if (response.content) {
        assistantMessage += response.content;
        // Must temporarily set the white space to preserve spaces in the message. Otherwise,
        // assigning `assistantMessage` to `innerText` will remove the spaces.
        // (e.g. "fn main() { return 5; }" will become "fn main() {return 5;}")
        // However, we do not want the style to be permanent, because then the inner HTML elements would be
        // spaced based on their literal spacing (e.g., newlines and spaces in the HTML) which would create
        // extra spacing between elements.
        assistantMessageDiv.style.whiteSpace = "pre";
        // Marked distinguishes between escaped HTML and "real" HTML.
        // For example, "<subdomain>.githubusercontent.com" is rendered as if `<subdomain>` is an HTML tag.
        // In particular, real LaTeX HTML e.g. "<span class="mord mathbf">A</span>" is not escaped.
        // In contrast "&lt;subdomain&gt;.github.usercontent.com" is rendered as text (<subdomain>)

        // Render markedown then LaTeX. Marked assumes the input text is a raw string with markdown formatting
        // and no special HTML (e.g. `\n` instead of `<br>`, where `\n# Header` is rendered as a `<h1>` header
        // but `<br># Header` does not render the header).
        // LaTeX parsing simply replaces LaTeX strings with MathML. The LaTeX strings should not be affected
        // by the markdown parsing.

        // Assistant message is a plain string, no special HTML formatting
        // The assistant message may have HTML-like content "e.g. <subdomain>.githubusercontent.com"
        // and these should not be interpreted as HTML tags. Marked will convert these characters to
        // HTML number or entity codes (e.g. "&lt;subdomain&gt;.github.usercontent.com")
        const markedParsedHtml = markdownProcessor.parse(assistantMessage);
        assistantMessageDiv.innerHTML = markedParsedHtml;
        // Use innerHTML instead of innerText
        // Assistant message may have HTML-like content, e.g. "<subdomain>.githubusercontent.com"
        // but is really text. Using innerHTML will escape the HTML-like characters.
        // Using innerText would mistake the HTML-like characters for actual HTML tags.
        // In the case there are HTML-like characters above, the innerHTML will be
        // "&lt;subdomain&gt;.github.usercontent.com"
        assistantMessageDiv.style.whiteSpace = "normal";
        isFirst = false;
      }

      if (response.doneWithoutError || response.error) {
        // Always reenable the send button after the request is complete
        boxData.isRequestInProgress = false;
        boxData.sendBtn.disabled = false;
        boxData.sendBtn.classList.remove("disabled");
      }
    });
  }
}

/**
 * On scroll or initial creation, update the position of the chat box
 * and the chat icon so that it remains aligned with the highlighted text.
 * @param {BoxData} boxData
 */
function setInitialChatBoxPosition(boxData: BoxData) {
  const { mainShadowGroup, chatBox, range } = boxData;
  const rect = range.getBoundingClientRect();

  const parentElement = mainShadowGroup.parentElement;
  if (!parentElement) return;
  const parentRect = parentElement.getBoundingClientRect();
  const chatBoxRect = chatBox.getBoundingClientRect();

  // Position relative to the parent element
  // Vertical offset: place box near the highlighted text inside parent
  // Place below the highlighted text
  const topOffset = 5;
  const topPos = rect.bottom - parentRect.top + topOffset;
  const containerWidth = chatBoxRect.width;

  // Center the container horizontally below the highlighted text
  const centering = (rect.width - containerWidth) / 2;
  const highlightedTextLeftMost = rect.left - parentRect.left;
  let leftPos = highlightedTextLeftMost + centering;

  if (configuration.boxPlacement) {
    if (boxCachedPosition) {
      // Use the cached value to position the chat box
      leftPos = boxCachedPosition.x;
    }
  }
  mainShadowGroup.style.top = `${topPos}px`;
  mainShadowGroup.style.left = `${leftPos}px`;
}

/**
 * Collapse the chat box into a small chat icon.
 * @param {HTMLElement} chatBox
 */
function collapseChatBox(chatBox: HTMLElement) {
  const chatBoxDatum = chatBoxData.find((box) => box.chatBox === chatBox);
  if (!chatBoxDatum) return;

  // Hide the main chat box
  chatBox.style.display = "none";

  // Show the chat icon
  const { chatIcon } = chatBoxDatum;
  chatIcon.style.display = "flex";
}

/**
 * Bring a chat box to the front.
 * @param {MainShadowGroup} mainShadowGroup - The chat box (element group) to bring to the front.
 */
function bringGroupToFront(mainShadowGroup: MainShadowGroup) {
  // Reset z-index for all boxes and remove highlight
  chatBoxData.forEach((box) => {
    box.mainShadowGroup.style.zIndex = BASE_ZINDEX;
    box.highlightManager.markAsNonSelected();
    // Clear context highlights from other boxes
    box.highlightManager.clearContextHighlights();
    if (box.chatIcon) box.chatIcon.style.zIndex = BASE_ZINDEX;
  });
  mainShadowGroup.style.zIndex = TOP_CHATBOX_ZINDEX;

  // Highlight the currently selected box's highlighted text and context
  const chatBoxDatum = chatBoxData.find(
    (box) => box.mainShadowGroup === mainShadowGroup
  );
  if (chatBoxDatum) {
    chatBoxDatum.highlightManager.markAsSelected();
    // Only show context highlights for the focused box
    chatBoxDatum.highlightManager.setContextRanges(
      chatBoxDatum.contextTextNodes
    );
  }
}

/**
 * Make an element draggable.
 * @param {HTMLElement} element - The element to make draggable. This is the handle if header is not provided.
 * @param {HTMLElement | null} header - The optional header element to use as the drag handle.
 */
function makeDraggable(
  element: HTMLElement,
  header: HTMLElement | null = null
) {
  const dragHandle = header || element;
  let prevOffsetLeft = 0, // Relative to the parent element
    prevOffsetTop = 0, // Relative to the parent element
    startDragLeft = 0, // Relative to the viewport
    startDragTop = 0; // Relative to the viewport
  let dragThreshold = 0.5,
    isDragging = false,
    hasMoved = false;

  dragHandle.addEventListener("mousedown", (e) => {
    isDragging = true;
    hasMoved = false;
    prevOffsetLeft = element.offsetLeft;
    prevOffsetTop = element.offsetTop;
    startDragLeft = e.clientX;
    startDragTop = e.clientY;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  function onMouseMove(e: MouseEvent) {
    if (!isDragging) return;
    // Only mark hasMoved if the element offsets are above a threshold
    // to prevent clicks being treated as drags
    const dragX = e.clientX - startDragLeft;
    const dragY = e.clientY - startDragTop;
    const newX = prevOffsetLeft + dragX;
    const newY = prevOffsetTop + dragY;
    if (Math.abs(dragX) > dragThreshold || Math.abs(dragY) > dragThreshold) {
      hasMoved = true;
    }
    element.style.left = `${newX}px`;
    element.style.top = `${newY}px`;
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);

    if (configuration.boxPlacement && isDragging) {
      // Save the new box position if user toggles box placement caching and has dragged the box
      boxCachedPosition = { x: element.offsetLeft };
    }
    isDragging = false;
  }

  // Prevent the chat box from opening when dragging the chat icon
  dragHandle.addEventListener("click", (e) => {
    if (hasMoved) {
      // Stop all other event handlers from firing on this event,
      // including those from the current object (chat icon)
      e.stopImmediatePropagation();
    }
  });
}

/**
 * Make a chat box resizable.
 * @param {ChatBox} chatBox - The chat box to make resizable.
 */
function makeResizable(chatBox: ChatBox) {
  // Define resizer styles for all four corners
  const resizerPositions = [
    { bottom: "0", right: "0", cursor: "se-resize" }, // Bottom right
    { bottom: "0", left: "0", cursor: "sw-resize" }, // Bottom left
    { top: "0", left: "0", cursor: "nw-resize" }, // Top left
    { top: "0", right: "0", cursor: "ne-resize" }, // Top right
  ];

  resizerPositions.forEach((position) => {
    const resizer = document.createElement("div");
    resizer.classList.add("gptthreads-resizer");
    Object.assign(resizer.style, {
      position: "absolute",
      width: "10px",
      height: "10px",
      backgroundColor: "transparent",
      ...position,
    });

    chatBox.appendChild(resizer);

    let isResizing = false;
    let startX = 0,
      startY = 0,
      startWidth = 0,
      startHeight = 0;

    resizer.addEventListener("mousedown", (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const chatBoxBoundingRect = chatBox.getBoundingClientRect();
      startWidth = chatBoxBoundingRect.width;
      startHeight = chatBoxBoundingRect.height;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    function onMouseMove(e: MouseEvent) {
      if (!isResizing) return;

      // Adjust width and height based on the corner being dragged
      if (position.right !== undefined) {
        chatBox.style.width = `${startWidth + (e.clientX - startX)}px`;
      } else if (position.left !== undefined) {
        chatBox.style.width = `${startWidth - (e.clientX - startX)}px`;
        chatBox.style.left = `${e.clientX}px`;
      }

      if (position.bottom !== undefined) {
        chatBox.style.height = `${startHeight + (e.clientY - startY)}px`;
      } else if (position.top !== undefined) {
        chatBox.style.height = `${startHeight - (e.clientY - startY)}px`;
        chatBox.style.top = `${e.clientY}px`;
      }

      // Save the resized width and height if user toggles box size caching
      if (configuration.boxSize) {
        const chatBoxBoundingRect = chatBox.getBoundingClientRect();
        currentChatWH.width = chatBoxBoundingRect.width;
        currentChatWH.height = chatBoxBoundingRect.height;
      }
    }

    function onMouseUp() {
      isResizing = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
  });
}

/**
 * Append a message to the chat history DOM and update internal data.
 * @param {HTMLDivElement} chatHistoryDivs - The chat history container DOM element.
 * @param {Role} role - "user" or "assistant"
 * @param {string} text - The message text
 * @returns {HTMLDivElement} The appended message DOM element.
 */
function appendMessageDiv(
  chatHistoryDivs: HTMLDivElement,
  role: Role,
  text: string
): HTMLDivElement {
  const msg = document.createElement("div");
  msg.classList.add("gptthreads-message", `gptthreads-${role}`);
  msg.innerText = text;
  if (role === Role.User) {
    // Use a container to right align user messages
    const msgContainer = document.createElement("div");
    msgContainer.classList.add("gptthreads-user-container");
    msgContainer.appendChild(msg);
    chatHistoryDivs.appendChild(msgContainer);
  } else {
    chatHistoryDivs.appendChild(msg);
  }
  chatHistoryDivs.scrollTop = chatHistoryDivs.scrollHeight;

  // Update the corresponding chat box data
  const chatBox = chatHistoryDivs.closest(".gptthreads-container");
  const chatBoxDatum = chatBoxData.find((box) => box.chatBox === chatBox);
  if (chatBoxDatum) {
    chatBoxDatum.messages.push({ role, content: text });
  }
  return msg;
}

/**
 * Append a message to the chat history data.
 * @param {ChatHistoryList} chatHistoryList - The chat history list to append to.
 * @param {Role} role - "user" or "assistant"
 * @param {string} content - The message text
 */
function appendMessageList(
  chatHistoryList: ChatHistoryList,
  role: Role,
  content: string
) {
  chatHistoryList.push({ role, content });
}

/**
 * Remove a specific chat box, its DOM, and associated data.
 * @param {ChatBox} chatBox - The chat box container DOM element to remove.
 */
function removeChatBox(chatBox: ChatBox) {
  const chatBoxDatum = chatBoxData.find((box) => box.chatBox === chatBox);
  if (chatBoxDatum && chatBoxDatum.chatIcon) {
    chatBoxDatum.chatIcon.remove();
  }
  chatBox.remove();
  chatBoxData = chatBoxData.filter((box) => box.chatBox.id !== chatBox.id);
  if (chatBoxDatum) {
    chatBoxDatum.highlightManager.removeHighlight();
  }
  if (chatBoxDatum && chatBoxDatum.mainShadowGroup) {
    chatBoxDatum.mainShadowGroup.remove();
  }
}

// Load saved settings from chrome storage on changes
chrome.storage.onChanged.addListener((changes, _) => {
  for (let key in changes) {
    if (Object.prototype.hasOwnProperty.call(configuration, key)) {
      configuration[key] = changes[key].newValue;
    }
  }
});

// Initialize configuration properties on start up
// Extension content script is explicitly loaded on page load instead of document idle
document.addEventListener("DOMContentLoaded", () => {
  console.debug("Loading from chrome storage");
  // First, get the saved settings.
  chrome.storage.sync.get(
    [
      "boxPlacement",
      "boxSize",
      "maxResponseWords",
      "modelVersion",
      "extensionToggle",
      "contextWords",
      "showContextHighlights",
    ],
    (data: SyncStorage) => {
      for (const key of configKeys) {
        if (Object.prototype.hasOwnProperty.call(configuration, key)) {
          if (data[key] !== undefined) {
            configuration[key] = data[key];
          }
        }
      }

      chrome.storage.session.get("gptThreadsApiKey", (sessionData) => {
        const apiKey = sessionData?.gptThreadsApiKey;
        if (apiKey) {
          configuration["gptThreadsApiKey"] = apiKey;
        }

        // Write the entire configuration (defaults plus any saved overrides)
        chrome.storage.sync.set(configuration, () => {});
      });
    }
  );
});
