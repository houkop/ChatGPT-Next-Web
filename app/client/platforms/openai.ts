"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  DEFAULT_API_HOST,
  DEFAULT_MODELS,
  OpenaiPath,
  Azure,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import { useAccessStore, useAppConfig, useChatStore } from "@/app/store";
import { collectModelsWithDefaultModel } from "@/app/utils/model";
import { cloudflareAIGatewayUrl } from "@/app/utils/cloudflare";

import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { 
  getNewStuff,
  getModelForInstructVersion,
} from './NewStuffLLMs';
import { prettyObject } from "@/app/utils/format";
import { getClientConfig } from "@/app/config/client";
import { getProviderFromState } from "@/app/utils";
import {
  getMessageTextContent,
  getMessageImages,
  isVisionModel,
} from "@/app/utils";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

export interface RequestPayload {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  stream?: boolean;
  model: string;
  temperature: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_p: number;
  max_tokens?: number;
}

export class ChatGPTApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    const isAzure = path.includes("deployments");
    if (accessStore.useCustomConfig) {
      if (isAzure && !accessStore.isValidAzure()) {
        throw Error(
          "incomplete azure config, please check it in your settings page",
        );
      }

      baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = isAzure ? ApiPath.Azure : ApiPath.OpenAI;
      baseUrl = isApp ? DEFAULT_API_HOST + "/proxy" + apiPath : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (
      !baseUrl.startsWith("http") &&
      !isAzure &&
      !baseUrl.startsWith(ApiPath.OpenAI)
    ) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    // try rebuild url, when using cloudflare ai gateway in client
    return cloudflareAIGatewayUrl([baseUrl, path].join("/"));
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  async chat(options: ChatOptions) {
    const visionModel = isVisionModel(options.config.model);
    const messages = options.messages.map((v) => ({
      role: v.role,
      content: visionModel ? v.content : getMessageTextContent(v),
    }));

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    const cfgspeed_animation = useAppConfig.getState().speed_animation;       

    const defaultModel = modelConfig.model;

    const userMessages = messages.filter((msg) => msg.role === "user");
    const userMessage = userMessages[userMessages.length - 1]?.content;
    /**
     * Represents the actual model used for DALL·E Models.
     * @author H0llyW00dzZ
     * @remarks This is the actual model used for DALL·E Models.
     * @usage in this chat: prompt
     * @example : A Best Picture of Andromeda Galaxy
     */
    const actualModel = getModelForInstructVersion(modelConfig.model);
    const { max_tokens } = getNewStuff(
      modelConfig.model,
      modelConfig.max_tokens,
      modelConfig.useMaxTokens,
    );
    const requestPayloads = {
      chat: {
        messages,
        stream: options.config.stream,
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        presence_penalty: modelConfig.presence_penalty,
        frequency_penalty: modelConfig.frequency_penalty,
        top_p: modelConfig.top_p,
        ...(max_tokens !== undefined ? { max_tokens } : {}), // Spread the max_tokens value if defined
        // max_tokens: Math.max(modelConfig.max_tokens, 1024),
        // Please do not ask me why not send max_tokens, no reason, this param is just shit, I dont want to explain anymore.
      
      },
    image: {
      model: actualModel,
      prompt: userMessage,
      n: modelConfig.n,
      quality: modelConfig.quality,
      style: modelConfig.style,
      size: modelConfig.size,
      },
    };

    const magicPayload = getNewStuff(defaultModel);
    const provider = getProviderFromState();

    let payload;
    if (magicPayload.isDalle) {
      if (defaultModel.includes("dall-e-2")) {
        const { quality, style, ...imagePayload } = requestPayloads.image;
        payload = { image: imagePayload };
      } else {
        payload = { image: requestPayloads.image };
      }
    } else if (magicPayload.isNewModel) {
      payload = { chat: requestPayloads.chat };
    } else {
      const { max_tokens, ...oldChatPayload } = requestPayloads.chat;
      payload = { chat: oldChatPayload };
    }

    console.log(`[Request] [${provider}] payload: `, payload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      /**
       * Represents the dallemodels variable.
       * @author H0llyW00dzZ
       */
      const dallemodels = magicPayload.isDalle;

      let chatPath = dallemodels
        ? this.path(OpenaiPath.ImageCreationPath)
        : this.path(OpenaiPath.ChatPath);

      let requestPayload;
      if (dallemodels) {
        /**
         * Author : @H0llyW00dzZ
         * Use the image payload structure
         */
        if (defaultModel.includes("dall-e-2")) {
          /**
           * Magic TypeScript payload parameter 🎩 🪄
           **/
          const { quality, style, ...imagePayload } = requestPayloads.image;
          requestPayload = imagePayload;
        } else {
          requestPayload = requestPayloads.image;
        }
      } else {
        /**
         * Use the chat model payload structure
         */
        requestPayload = requestPayloads.chat;
      }
      if (modelConfig.providerName === ServiceProvider.Azure) {
        // find model, and get displayName as deployName
        const { models: configModels, customModels: configCustomModels } =
          useAppConfig.getState();
        const {
          defaultModel,
          customModels: accessCustomModels,
          useCustomConfig,
        } = useAccessStore.getState();
        const models = collectModelsWithDefaultModel(
          configModels,
          [configCustomModels, accessCustomModels].join(","),
          defaultModel,
        );
        const model = models.find(
          (model) =>
            model.name === modelConfig.model &&
            model?.provider?.providerName === ServiceProvider.Azure,
        );
        chatPath = this.path(
          Azure.ChatPath(
            (model?.displayName ?? model?.name) as string,
            useCustomConfig ? useAccessStore.getState().azureApiVersion : "",
          ),
        );
      } else {
        chatPath = this.path(OpenaiPath.ChatPath);
      }
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      if (shouldStream) {
        let responseText = "";
        let remainText = "";
        let finished = false;

        // animate response to make it looks smooth
        function animateResponseText() {
          if (finished || controller.signal.aborted) {
            responseText += remainText;
            console.log("[Response Animation] finished");
            if (responseText?.length === 0) {
              options.onError?.(new Error("empty response from server"));
            }
            return;
          }

          if (remainText.length > 0) {
            const fetchCount = Math.max(1, Math.round(remainText.length / cfgspeed_animation));
            const fetchText = remainText.slice(0, fetchCount);
            responseText += fetchText;
            remainText = remainText.slice(fetchCount);
            options.onUpdate?.(responseText, fetchText);
          }

          requestAnimationFrame(animateResponseText);
        }

        // start animaion
        animateResponseText();

        const finish = () => {
          if (!finished) {
            finished = true;
            options.onFinish(responseText + remainText);
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(chatPath, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log(
              "[OpenAI] request response content type: ",
              contentType,
            );

            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
            } else if (contentType?.startsWith("application/json")) {
              const jsonResponse = await res.clone().json();
              // Generic JSON response handling
              if (jsonResponse.data) {
                if (magicPayload.isDalle) {
                  // Specific handling for DALL·E responses
                  const imageUrl = jsonResponse.data?.[0]?.url;
                  const prompt = requestPayloads.image.prompt;
                  const revised_prompt = jsonResponse.data?.[0]?.revised_prompt;
                  const index = requestPayloads.image.n - 1;
                  const size = requestPayloads.image.size;


                  let imageDescription = `#### ${prompt} (${index + 1})\n\n\n | ![${imageUrl}](${imageUrl}) |\n|---|\n| Size: ${size} |\n| [Download Here](${imageUrl}) |\n| 🤖 AI Models: ${defaultModel} |`;
                  if (defaultModel.includes("dall-e-3")) {
                    imageDescription = `| ![${revised_prompt}](${imageUrl}) |\n|---|\n| Size: ${size} |\n| [Download Here](${imageUrl}) |\n| 🎩 🪄 Revised Prompt (${index + 1}): ${revised_prompt} |\n| 🤖 AI Models: ${defaultModel} |`;
                  }
                  responseText = `${imageDescription}`;
                }
                return; // this should be fix json response, unlike go so easy
              }
            }
            // Handle non-OK responses or unexpected content types
            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              let extraInfo = await res.clone().text();
              try {
                const resJson = await res.clone().json();
                extraInfo = prettyObject(resJson);
              } catch { }

              const responseTexts = [responseText];
              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              if (extraInfo) {
                responseTexts.push(extraInfo);
              }

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            const text = msg.data;
            try {
              const json = JSON.parse(text);
              const choices = json.choices as Array<{
                delta: { content: string };
              }>;
              const delta = choices[0]?.delta?.content;
              const textmoderation = json?.prompt_filter_results;

              if (delta) {
                remainText += delta;
              }

              if (
                textmoderation &&
                textmoderation.length > 0 &&
                ServiceProvider.Azure
              ) {
                const contentFilterResults =
                  textmoderation[0]?.content_filter_results;
                console.log(
                  `[${ServiceProvider.Azure}] [Text Moderation] flagged categories result:`,
                  contentFilterResults,
                );
              }
            } catch (e) {
              console.error("[Request] parse error", text, msg);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    if (this.disableListModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    const chatModels = resJson.data?.filter((m) => m.id.startsWith("gpt-"));
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      provider: {
        id: "openai",
        providerName: "OpenAI",
        providerType: "openai",
      },
    }));
  }

  /**
   * Saves the image from the response to the local filesystem.
   * @param imageResponse - The response containing the image data.
   * @param filename - The name of the file to be saved.
   * @returns A Promise that resolves when the image is saved successfully.
   * @throws If there is an error while saving the image.
   * @todo Implement the actual saving logic.
   * @note This method is currently not used. and subject to changed if there is a better way to save or store the image. (e.g. using own blob storage or aws s3,etc)
   * @author H0llyW00dzZ
   */
  private async saveImageFromResponse(imageResponse: any, filename: string): Promise<void> {
    try {
      const blob = await imageResponse.blob();

      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();

      URL.revokeObjectURL(url);

      console.log('Image saved successfully:', filename);
    } catch (e) {
      console.error('Failed to save image:', e);
    }
  }
}

export { OpenaiPath };
