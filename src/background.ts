// Starts or continues threads with OpenAI assistants. This is used instead of chat completions
// to automate historical chat compaction. OpenAI assistants still incur an input token cost of the
// entire chat history for every new message.
import OpenAI from "openai";
import { BkgToContentMessage, ContentToBkgMessage } from "./content";
import { Role } from "./definitions";

// Keep track of threads and assistants
type ThreadId = string;
type AssistantId = string;
const threadMap = new Map<string, ThreadId>();
const assistantMap = new Map<string, AssistantId>();

const ASSISTANT_CONFIGS = {
  "gpt-4o": {
    model: "gpt-4o",
    name: "GPT-4o Thread Assistant",
    instructions: "You are a helpful assistant.",
  },
  "gpt-4o-mini": {
    model: "gpt-4o-mini",
    name: "GPT-4o Mini Thread Assistant",
    instructions: "You are a helpful assistant.",
  },
  "o3-mini": {
    model: "o3-mini",
    name: "o3 Mini Thread Assistant",
    instructions: "You are a helpful assistant.",
    reasoning_effort: "medium",
  },
};

type ModelVersion = keyof typeof ASSISTANT_CONFIGS;

async function getOrCreateAssistant(
  openai: OpenAI,
  modelVersion: ModelVersion
): Promise<string> {
  const existingAssistantId = assistantMap.get(modelVersion);
  if (existingAssistantId) {
    return existingAssistantId;
  }

  const config = ASSISTANT_CONFIGS[modelVersion];
  if (!config) {
    throw new Error(`Unsupported model version: ${modelVersion}`);
  }

  const assistant = await openai.beta.assistants.create({
    ...config,
  });

  assistantMap.set(modelVersion, assistant.id);

  return assistant.id;
}

// Type safe wrapper around message sending
const sendMessageToContentScript = (
  port: chrome.runtime.Port,
  message: BkgToContentMessage
) => {
  port.postMessage(message);
};

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  console.assert(port.name === "openai_stream");
  port.onMessage.addListener((request: ContentToBkgMessage) => {
    if (request.type === "OPENAI_QUERY") {
      const {
        systemPrompt,
        prompt,
        maxCompletionTokens,
        modelVersion,
        chatHistoryList,
        conversationId,
      } = request;

      chrome.storage.session.get("gptThreadsApiKey", (data) => {
        const gptThreadsApiKey = data.gptThreadsApiKey;

        if (!gptThreadsApiKey) {
          sendMessageToContentScript(port, {
            error:
              "It looks like an OpenAI API key was not provided. Did you add your API key in the GPT Threads extension config?",
          });
          return;
        }
        const openai = new OpenAI({
          apiKey: gptThreadsApiKey,
        });

        (async () => {
          try {
            const assistantId = await getOrCreateAssistant(
              openai,
              modelVersion as ModelVersion
            );

            let threadId = threadMap.get(conversationId);
            if (!threadId) {
              // Note: Switching models in the middle of a conversation will not incur a cost of
              // replaying the chat history. With threads, the chat history is not repeatedly sent
              // to the assistant.
              const messages = [
                {
                  role: Role.User,
                  content: systemPrompt,
                },
                ...chatHistoryList,
              ];
              const thread = await openai.beta.threads.create({
                messages,
              });
              threadId = thread.id;
              threadMap.set(conversationId, threadId);
            }
            const message = await openai.beta.threads.messages.create(
              threadId,
              {
                role: Role.User,
                content: prompt,
              }
            );
            let runId = "";
            const run = openai.beta.threads.runs
              .stream(threadId, {
                assistant_id: assistantId,
                max_completion_tokens: maxCompletionTokens,
              })
              .on(
                "textDelta",
                (
                  delta: OpenAI.Beta.Threads.TextDelta,
                  snapshot: OpenAI.Beta.Threads.Text
                ) => {
                  // Do not trigger on both textCreated and textDelta because they have redundant content
                  sendMessageToContentScript(port, {
                    content: delta.value,
                  });
                }
              )
              .on(
                "textDone",
                (
                  content: OpenAI.Beta.Threads.Text,
                  snapshot: OpenAI.Beta.Threads.Message
                ) => {
                  sendMessageToContentScript(port, {
                    doneWithoutError: true,
                  });
                }
              )
              .on(
                "messageDone",
                async (message: OpenAI.Beta.Threads.Message) => {
                  const messageRunId = message.run_id ?? "";
                  runId = messageRunId;
                  const usage = await openai.beta.threads.runs.steps.list(
                    threadId,
                    runId
                  );
                  const stepWithUsage = usage.data[0];

                  console.log("Usage:", stepWithUsage);
                }
              );
          } catch (error) {
            console.error("Error in OpenAI API:", error);
            sendMessageToContentScript(port, {
              error: "Failed to fetch response from OpenAI API. " + error,
            });
          }
        })();
      });
    }
  });
});
