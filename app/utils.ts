import { getClientConfig } from "./config/client";
import { useEffect, useState } from "react";
import { showToast } from "./components/ui-lib";
import Locale from "./locales";
import { useAccessStore } from "./store";
import { RequestMessage } from "./client/api";
import { DEFAULT_MODELS } from "./constant";

export function trimTopic(topic: string) {
  // Fix an issue where double quotes still show in the Indonesian language
  // This will remove the specified punctuation from the end of the string
  // and also trim quotes from both the start and end if they exist.
  return (
    topic
      // fix for gemini
      .replace(/^["“”*]+|["“”*]+$/g, "")
      .replace(/[，。！？”“"、,.!?*]*$/, "")
  );
}

const isApp = !!getClientConfig()?.isApp;

export async function copyToClipboard(text: string) {
  try {
    if (isApp && window.__TAURI__) {
      window.__TAURI__.writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }

    showToast(Locale.Copy.Success);
  } catch (error) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand("copy");
      showToast(Locale.Copy.Success);
    } catch (error) {
      showToast(Locale.Copy.Failed);
    }
    document.body.removeChild(textArea);
  }
}
//To ensure the expected functionality, the default file format must be JSON.
export async function downloadAs(text: object, filename: string) {
  const json = JSON.stringify(text);
  const blob = new Blob([json], { type: "application/json" });
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  try {
    if (window.__TAURI__) {
      /**
       * Fixed client app [Tauri]
       * Resolved the issue where files couldn't be saved when there was a `:` in the dialog.
      **/
      const fileName = filename.replace(/:/g, '');
      const fileExtension = fileName.split('.').pop();
      const result = await window.__TAURI__.dialog.save({
        defaultPath: `${fileName}`,
        filters: [
          {
            name: `${fileExtension} files`,
            extensions: [`${fileExtension}`],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });

      if (result !== null) {
        await window.__TAURI__.fs.writeBinaryFile(
          result,
          Uint8Array.from(uint8Array)
        );
        showToast(Locale.Download.Success);
      } else {
        showToast(Locale.Download.Failed);
      }
    } else {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${filename}`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast(Locale.Download.Success);
    }
  } catch (error) {
    showToast(Locale.Download.Failed);
  }
}

// Assuming you have a function to get the provider from the state
export function getProviderFromState(): string {
  const accessStore = useAccessStore.getState();
  return accessStore.provider;
}

export function compressImage(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    fetch(URL.createObjectURL(file))
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob))
      .then((imageBitmap) => {
        let canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
        let ctx = canvas.getContext("2d");
        let width = imageBitmap.width;
        let height = imageBitmap.height;
        let quality = 0.9;

        const checkSizeAndPostMessage = () => {
          canvas
            .convertToBlob({ type: "image/jpeg", quality: quality })
            .then((blob) => {
              const reader = new FileReader();
              reader.onloadend = function () {
                const base64data = reader.result;
                if (typeof base64data !== "string") {
                  reject("Invalid base64 data");
                  return;
                }
                if (base64data.length < maxSize) {
                  resolve(base64data);
                  return;
                }
                if (quality > 0.5) {
                  // Prioritize quality reduction
                  quality -= 0.1;
                } else {
                  // Then reduce the size
                  width *= 0.9;
                  height *= 0.9;
                }
                canvas.width = width;
                canvas.height = height;

                ctx?.drawImage(imageBitmap, 0, 0, width, height);
                checkSizeAndPostMessage();
              };
              reader.readAsDataURL(blob);
            });
        };
        ctx?.drawImage(imageBitmap, 0, 0, width, height);
        checkSizeAndPostMessage();
      })
      .catch((error) => {
        throw error;
      });
  });
}

export function readFromFile() {
  return new Promise<string>((res, rej) => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json";

    fileInput.onchange = (event: any) => {
      const file = event.target.files[0];
      const fileReader = new FileReader();
      fileReader.onload = (e: any) => {
        res(e.target.result);
      };
      fileReader.onerror = (e) => rej(e);
      fileReader.readAsText(file);
    };

    fileInput.click();
  });
}

export function isIOS() {
  const userAgent = navigator.userAgent.toLowerCase();
  return (
    /iphone|ipad|ipod|macintosh/.test(userAgent) ||
    (userAgent.includes("mac") && "ontouchend" in document)
  );
}

export function useWindowSize() {
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return size;
}

export const MOBILE_MAX_WIDTH = 600;
export function useMobileScreen() {
  const { width } = useWindowSize();

  return width <= MOBILE_MAX_WIDTH;
}

export function isFirefox() {
  return (
    typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent)
  );
}

export function selectOrCopy(el: HTMLElement, content: string) {
  const currentSelection = window.getSelection();

  if (currentSelection?.type === "Range") {
    return false;
  }

  copyToClipboard(content);

  return true;
}

function getDomContentWidth(dom: HTMLElement) {
  const style = window.getComputedStyle(dom);
  const paddingWidth =
    parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const width = dom.clientWidth - paddingWidth;
  return width;
}

function getOrCreateMeasureDom(id: string, init?: (dom: HTMLElement) => void) {
  let dom = document.getElementById(id);

  if (!dom) {
    dom = document.createElement("span");
    dom.style.position = "absolute";
    dom.style.wordBreak = "break-word";
    dom.style.fontSize = "14px";
    dom.style.transform = "translateY(-200vh)";
    dom.style.pointerEvents = "none";
    dom.style.opacity = "0";
    dom.id = id;
    document.body.appendChild(dom);
    init?.(dom);
  }

  return dom!;
}

export function autoGrowTextArea(dom: HTMLTextAreaElement) {
  const measureDom = getOrCreateMeasureDom("__measure");
  const singleLineDom = getOrCreateMeasureDom("__single_measure", (dom) => {
    dom.innerText = "TEXT_FOR_MEASURE";
  });

  const width = getDomContentWidth(dom);
  measureDom.style.width = width + "px";
  measureDom.innerText = dom.value !== "" ? dom.value : "1";
  measureDom.style.fontSize = dom.style.fontSize;
  const endWithEmptyLine = dom.value.endsWith("\n");
  const height = parseFloat(window.getComputedStyle(measureDom).height);
  const singleLineHeight = parseFloat(
    window.getComputedStyle(singleLineDom).height,
  );

  const rows =
    Math.round(height / singleLineHeight) + (endWithEmptyLine ? 1 : 0);

  return rows;
}

export function getCSSVar(varName: string) {
  return getComputedStyle(document.body).getPropertyValue(varName).trim();
}

/**
 * Detects Macintosh
 */
export function isMacOS(): boolean {
  if (typeof window !== "undefined") {
    let userAgent = window.navigator.userAgent.toLocaleLowerCase();
    const macintosh = /iphone|ipad|ipod|macintosh/.test(userAgent);
    return !!macintosh;
  }
  return false;
}

export function getMessageTextContent(message: RequestMessage) {
  if (typeof message.content === "string") {
    return message.content;
  }
  for (const c of message.content) {
    if (c.type === "text") {
      return c.text ?? "";
    }
  }
  return "";
}

export function getMessageImages(message: RequestMessage): string[] {
  if (typeof message.content === "string") {
    return [];
  }
  const urls: string[] = [];
  for (const c of message.content) {
    if (c.type === "image_url") {
      urls.push(c.image_url?.url ?? "");
    }
  }
  return urls;
}

export function isVisionModel(model: string) {
  
  // Note: This is a better way using the TypeScript feature instead of `&&` or `||` (ts v5.5.0-dev.20240314 I've been using)

  const visionKeywords = [
    "vision",
    "claude-3",
    "gemini-1.5-pro",
  ];

  const isGpt4Turbo = model.includes("gpt-4-turbo") && !model.includes("preview");

  return (
    visionKeywords.some((keyword) => model.includes(keyword)) || isGpt4Turbo
  );
}
