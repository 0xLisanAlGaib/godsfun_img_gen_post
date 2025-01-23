import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    generateObject,
    composeContext,
} from "@elizaos/core";
import { Scraper } from "agent-twitter-client";
import * as fs from "fs";
import * as path from "path";
import { tweetTemplate } from "../templates";
import { isTweetContent, TweetSchema } from "../types";

function getGeneratedImagesPath(): string {
    // Match the path used by image generation plugin
    const relativePath = process.env.GENERATED_IMAGES_PATH || "generatedImages";
    const workspaceRoot = process.cwd();
    const absolutePath = path.join(workspaceRoot, relativePath);

    // Create directory if it doesn't exist
    if (!fs.existsSync(absolutePath)) {
        fs.mkdirSync(absolutePath, { recursive: true });
    }

    return absolutePath;
}

async function composeTweetWithImage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
): Promise<string> {
    try {
        const context = composeContext({
            state,
            template: tweetTemplate,
        });

        const tweetContentObject = await generateObject({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
            schema: TweetSchema,
            stop: ["\n"],
        });

        if (!isTweetContent(tweetContentObject.object)) {
            elizaLogger.error(
                "Invalid tweet content:",
                tweetContentObject.object
            );
            return;
        }

        return tweetContentObject.object.text.trim();
    } catch (error) {
        elizaLogger.error("Error composing tweet:", error);
        throw error;
    }
}

async function getLatestImage(imagePath: string): Promise<string | null> {
    try {
        elizaLogger.log("Looking for images in:", imagePath);
        const files = fs.readdirSync(imagePath);
        elizaLogger.log("Found files:", files);

        const imageFiles = files.filter((file) =>
            /\.(jpg|jpeg|png|gif)$/i.test(file)
        );

        if (imageFiles.length === 0) {
            elizaLogger.error("No image files found in the directory");
            return null;
        }

        const imageStats = imageFiles.map((file) => ({
            file,
            mtime: fs.statSync(path.join(imagePath, file)).mtime,
        }));

        const latestImage = imageStats.sort(
            (a, b) => b.mtime.getTime() - a.mtime.getTime()
        )[0];

        elizaLogger.log("Found latest image:", latestImage.file);
        return path.join(imagePath, latestImage.file);
    } catch (error) {
        elizaLogger.error("Error getting latest image:", error);
        return null;
    }
}

async function generateNewImage(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
): Promise<string | null> {
    try {
        // Find the image generation plugin and action
        const generateImageAction = runtime.actions.find(
            (a) => a.name === "GENERATE_IMAGE"
        );

        if (!generateImageAction) {
            elizaLogger.error("Image generation action not found");
            return null;
        }

        // Create a promise to handle the callback
        let generatedImagePath: string | null = null;
        const imagePromise = new Promise<string | null>((resolve) => {
            generateImageAction.handler(
                runtime,
                message,
                state,
                {}, // Default options
                async (response, attachments) => {
                    if (attachments && attachments.length > 0) {
                        generatedImagePath = attachments[0].url;
                        resolve(generatedImagePath);
                    } else {
                        resolve(null);
                    }
                    return [];
                }
            );
        });

        // Wait for image generation with timeout
        const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 30000)
        );

        const result = await Promise.race([imagePromise, timeoutPromise]);

        if (!result) {
            elizaLogger.error("Image generation timed out or failed");
            return null;
        }

        elizaLogger.log("Image generation completed successfully:", result);
        return result;
    } catch (error) {
        elizaLogger.error("Error generating image:", error);
        return null;
    }
}

async function postImageTweet(
    runtime: IAgentRuntime,
    imagePath: string,
    tweetContent: string
): Promise<boolean> {
    try {
        const twitterClient = runtime.clients.twitter?.client?.twitterClient;
        const scraper = twitterClient || new Scraper();

        if (!twitterClient) {
            const username = runtime.getSetting("TWITTER_USERNAME");
            const password = runtime.getSetting("TWITTER_PASSWORD");
            const email = runtime.getSetting("TWITTER_EMAIL");
            const twitter2faSecret = runtime.getSetting("TWITTER_2FA_SECRET");

            if (!username || !password) {
                elizaLogger.error(
                    "Twitter credentials not configured in environment"
                );
                return false;
            }

            await scraper.login(username, password, email, twitter2faSecret);
            if (!(await scraper.isLoggedIn())) {
                elizaLogger.error("Failed to login to Twitter");
                return false;
            }
        }

        elizaLogger.log("Attempting to send tweet with image:", imagePath);
        elizaLogger.log("Tweet content:", tweetContent);

        // Read image file as buffer
        const imageBuffer = fs.readFileSync(imagePath);

        try {
            // First upload the media
            const uploadResult = await scraper.uploadMedia(imageBuffer);
            const mediaId = uploadResult.media_id_string;

            if (!mediaId) {
                elizaLogger.error("Failed to upload media");
                return false;
            }

            // Then create tweet with media
            const result = await scraper.sendTweet(tweetContent, {
                media: { media_ids: [mediaId] },
            });

            const body = await result.json();

            if (body.errors) {
                const error = body.errors[0];
                elizaLogger.error(
                    `Twitter API error (${error.code}): ${error.message}`
                );
                return false;
            }

            elizaLogger.log("Successfully posted tweet with image");
            return true;
        } catch (error) {
            throw new Error(`Media Tweet failed: ${error}`);
        }
    } catch (error) {
        elizaLogger.error("Error posting image tweet:", error);
        return false;
    }
}

export const postImageAction: Action = {
    name: "POST_IMAGE_TWEET",
    similes: [
        "TWEET_IMAGE",
        "POST_IMAGE",
        "SHARE_IMAGE",
        "GENERATE_AND_TWEET",
        "POST_LATEST_IMAGE",
        "POST_GENERATED_IMAGE",
        "TWEET_LATEST_IMAGE",
    ],
    description:
        "Generate an image and/or post the most recent image to Twitter",
    validate: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ) => {
        // Check Twitter credentials
        const username = runtime.getSetting("TWITTER_USERNAME");
        const password = runtime.getSetting("TWITTER_PASSWORD");
        const email = runtime.getSetting("TWITTER_EMAIL");
        const hasCredentials = !!username && !!password && !!email;

        // Check if we need image generation capabilities
        const shouldGenerate =
            message.content.text.toLowerCase().includes("generate") ||
            message.content.text.toLowerCase().includes("create");

        if (shouldGenerate) {
            // Verify image generation plugin is available
            const imageGenPlugin = runtime.plugins.find((p) =>
                p.actions?.some((a) => a.name === "GENERATE_IMAGE")
            );
            const hasImageGen = !!imageGenPlugin;

            elizaLogger.log(
                `Validation - Has credentials: ${hasCredentials}, Has image generation: ${hasImageGen}, Should generate: ${shouldGenerate}`
            );

            return hasCredentials && hasImageGen;
        }

        elizaLogger.log(`Validation - Has credentials: ${hasCredentials}`);
        return hasCredentials;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<boolean> => {
        try {
            let imagePath: string | null = null;

            // Check if we need to generate a new image
            if (
                message.content.text.toLowerCase().includes("generate") ||
                message.content.text.toLowerCase().includes("create")
            ) {
                elizaLogger.log("Starting image generation process");
                imagePath = await generateNewImage(runtime, message, state);
                if (!imagePath) {
                    elizaLogger.error("Failed to generate image");
                    return false;
                }
            } else {
                // Get the latest image from directory
                const imagesDir = getGeneratedImagesPath();
                imagePath = await getLatestImage(imagesDir);
            }

            if (!imagePath) {
                elizaLogger.error("No image found to post");
                return false;
            }

            // Generate tweet text
            const tweetContent = await composeTweetWithImage(
                runtime,
                message,
                state
            );
            if (!tweetContent) {
                elizaLogger.error("Failed to generate tweet content");
                return false;
            }

            // Check for dry run mode
            if (process.env.TWITTER_DRY_RUN?.toLowerCase() === "true") {
                elizaLogger.info(
                    `Dry run: would have posted image tweet: ${imagePath} with text: ${tweetContent}`
                );
                return true;
            }

            // Post the tweet with the image
            return await postImageTweet(runtime, imagePath, tweetContent);
        } catch (error) {
            elizaLogger.error("Error in post image action:", error);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Generate an image of a sunset and post it" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll create a beautiful sunset image and share it on Twitter!",
                    action: "POST_IMAGE_TWEET",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Post the latest generated image" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll share the latest generated image on Twitter!",
                    action: "POST_IMAGE_TWEET",
                },
            },
        ],
    ],
};
