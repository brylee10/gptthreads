import { SyncStorage } from "../content";

document.addEventListener("DOMContentLoaded", () => {
  // Map keys to their corresponding DOM input elements.
  const elements: { [key: string]: HTMLInputElement | null } = {
    boxPlacement: document.getElementById("boxPlacement") as HTMLInputElement,
    boxSize: document.getElementById("boxSize") as HTMLInputElement,
    maxResponseWords: document.getElementById(
      "maxResponseWords"
    ) as HTMLInputElement,
    contextWords: document.getElementById("contextWords") as HTMLInputElement,
    modelVersion: document.getElementById("modelVersion") as HTMLInputElement,
    extensionToggle: document.getElementById(
      "extensionToggle"
    ) as HTMLInputElement,
    gptThreadsApiKey: document.getElementById(
      "gptThreadsApiKey"
    ) as HTMLInputElement,
    showContextHighlights: document.getElementById(
      "showContextHighlights"
    ) as HTMLInputElement,
  };

  // Helper function to update a DOM element's value based on type.
  const updateElement = (key: string, newValue: any) => {
    const el = elements[key];
    if (!el) return;
    if (el.type === "checkbox") {
      el.checked = newValue;
    } else {
      el.value = newValue.toString();
    }
  };

  const saveSettings = () => {
    const syncData: Partial<SyncStorage> = {};
    if (elements.boxPlacement)
      syncData.boxPlacement = elements.boxPlacement.checked;
    if (elements.boxSize) syncData.boxSize = elements.boxSize.checked;
    if (elements.maxResponseWords)
      syncData.maxResponseWords = parseInt(elements.maxResponseWords.value, 10);
    if (elements.contextWords)
      syncData.contextWords = parseInt(elements.contextWords.value, 10);
    if (elements.modelVersion)
      syncData.modelVersion = elements.modelVersion.value;
    if (elements.extensionToggle)
      syncData.extensionToggle = elements.extensionToggle.checked;
    if (elements.showContextHighlights)
      syncData.showContextHighlights = elements.showContextHighlights.checked;

    chrome.storage.sync.set(syncData, () => {
      if (chrome.runtime.lastError) {
        console.error("Error saving sync storage:", chrome.runtime.lastError);
      }
    });

    if (elements.gptThreadsApiKey) {
      chrome.storage.session.set(
        { gptThreadsApiKey: elements.gptThreadsApiKey.value },
        () => {
          if (chrome.runtime.lastError) {
            console.error(
              "Error saving session storage:",
              chrome.runtime.lastError
            );
          }
        }
      );
    }
  };

  chrome.storage.sync.get(
    [
      "boxPlacement",
      "boxSize",
      "maxResponseWords",
      "contextWords",
      "modelVersion",
      "extensionToggle",
      "showContextHighlights",
    ],
    (data: SyncStorage) => {
      for (const key in data) {
        updateElement(key, data[key]);
      }
    }
  );

  // Load the API key from session storage.
  chrome.storage.session.get("gptThreadsApiKey", (data) => {
    if (data && data.gptThreadsApiKey) {
      updateElement("gptThreadsApiKey", data.gptThreadsApiKey);
    }
  });

  // When any input or select changes, save the settings.
  document.querySelectorAll("input, select").forEach((element) => {
    element.addEventListener("change", saveSettings);
  });

  // Listen for storage changes. This should only occur once on initialization when the content script
  // syncs its default configuration. Otherwise, the popup sends changes to the content script.
  chrome.storage.onChanged.addListener((changes, namespace) => {
    for (const key in changes) {
      const { newValue } = changes[key];
      updateElement(key, newValue);
    }
  });
});
