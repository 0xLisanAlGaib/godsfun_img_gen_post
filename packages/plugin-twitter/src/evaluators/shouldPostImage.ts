import {
    ActionExample,
    IAgentRuntime,
    Memory,
    ModelClass,
    Evaluator,
    composeContext,
    generateObject,
    elizaLogger,
} from "@elizaos/core";

interface ShouldPostResponse {
    shouldPost: boolean;
}

function isShouldPostResponse(obj: unknown): obj is ShouldPostResponse {
    return (
        typeof obj === "object" &&
        obj !== null &&
        "shouldPost" in obj &&
        typeof (obj as any).shouldPost === "boolean"
    );
}

const shouldPostTemplate = `
TASK: Determine if the generated image should be posted to Twitter based on user intent.

# INSTRUCTIONS
Analyze the user's message to determine if they want the image posted to Twitter by checking for:
- Explicit mentions of Twitter posting (e.g. "tweet this", "post to twitter")
- General sharing intent (e.g. "share this", "post this")
- Context implying social media sharing

Response should be a JSON object with a single boolean field "shouldPost".

Recent Message:
{{recentMessages}}

Response format:
\`\`\`json
{
  "shouldPost": boolean
}
\`\`\``;

async function handler(runtime: IAgentRuntime, message: Memory) {
    try {
        elizaLogger.log("shouldPostImage evaluator handler started");
        elizaLogger.log("Processing message:", message.content.text);

        const state = await runtime.composeState(message);
        elizaLogger.log("State composed for evaluation");

        const context = composeContext({
            state,
            template: shouldPostTemplate,
        });
        elizaLogger.log("Context composed for model");

        const result = await generateObject({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        elizaLogger.log("Model response received:", result);

        if (!result?.object || !isShouldPostResponse(result.object)) {
            elizaLogger.error("Invalid response format from model:", result);
            return false;
        }

        elizaLogger.log(
            `Should post image to Twitter: ${result.object.shouldPost}`
        );
        return result.object.shouldPost;
    } catch (error) {
        elizaLogger.error("Error in shouldPostImage handler:", error);
        return false;
    }
}

export const shouldPostImageEvaluator: Evaluator = {
    name: "SHOULD_POST_IMAGE",
    similes: [
        "EVALUATE_POST_IMAGE",
        "CHECK_TWITTER_INTENT",
        "VERIFY_POSTING_INTENT",
        "SHOULD_TWEET_IMAGE",
    ],
    description:
        "Evaluates if a generated image should be posted to Twitter based on user intent",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory
    ): Promise<boolean> => {
        elizaLogger.log("shouldPostImage evaluator validate started");
        elizaLogger.log(
            "Checking message for image attachments:",
            message.content
        );

        // Only evaluate if there's a generated image in the message
        const hasGeneratedImage =
            message.content?.attachments?.some(
                (attachment) => attachment.source === "imageGeneration"
            ) ?? false;

        elizaLogger.log(`Message has generated image: ${hasGeneratedImage}`);
        return hasGeneratedImage;
    },
    handler,
    examples: [
        {
            context: "User wants to generate and post an image",
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Generate an image of a sunset and tweet it",
                        attachments: [
                            {
                                source: "imageGeneration",
                                url: "path/to/image.png",
                            },
                        ],
                    },
                },
            ] as ActionExample[],
            outcome: `\`\`\`json
{
  "shouldPost": true
}
\`\`\``,
        },
        {
            context: "User only wants to generate an image",
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "Create an image of a mountain landscape",
                        attachments: [
                            {
                                source: "imageGeneration",
                                url: "path/to/image.png",
                            },
                        ],
                    },
                },
            ] as ActionExample[],
            outcome: `\`\`\`json
{
  "shouldPost": false
}
\`\`\``,
        },
    ],
};
