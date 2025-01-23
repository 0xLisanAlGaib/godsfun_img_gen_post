import {
    MemoryManager,
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import * as path from "path";
import { createClient } from '@supabase/supabase-js';

function getGeneratedImagesPath(): string {
    const relativePath = process.env.GENERATED_IMAGES_PATH || "generatedImages";
    const workspaceRoot = process.cwd();
    return path.join(workspaceRoot, relativePath);
}

async function getLatestGeneratedImage(): Promise<string | null> {
    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );

        // Get the latest image from Supabase
        const { data, error } = await supabase
            .from('generated_images')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            elizaLogger.error('Error fetching from Supabase:', error);
            return null;
        }

        if (data && data.length > 0) {
            elizaLogger.log('Found latest image in Supabase:', data[0]);
            return data[0].storage_path;
        }

        return null;
    } catch (error) {
        elizaLogger.error('Error in getLatestGeneratedImage:', error);
        return null;
    }
}

export const imagePathProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        try {
            elizaLogger.log("imagePathProvider get started");
            elizaLogger.log("Processing message:", message.content.text);
            elizaLogger.log("Current state:", state);

            // First try to get the latest image from Supabase
            const supabaseImageUrl = await getLatestGeneratedImage();
            if (supabaseImageUrl) {
                elizaLogger.log("Found image in Supabase:", supabaseImageUrl);
                return supabaseImageUrl;
            }

            // Fallback to memory manager if no image found in Supabase
            const memoryManager = new MemoryManager({
                runtime,
                tableName: "images",
            });
            elizaLogger.log("Memory manager initialized for images table");

            // Get recent image memories
            elizaLogger.log("Fetching recent images for room:", message.roomId);
            const recentImages = await memoryManager.getMemories({
                roomId: message.roomId,
                count: 1,
                start: 0,
                end: Date.now(),
            });
            elizaLogger.log("Recent images fetched:", recentImages);

            // If we have a recent image memory, use its path
            if (recentImages && recentImages.length > 0) {
                const latestImage = recentImages[0];
                elizaLogger.log("Latest image memory:", latestImage);

                if (latestImage.content?.attachments?.[0]?.url) {
                    const imagePath = latestImage.content.attachments[0].url;
                    elizaLogger.log("Found image path from memory:", imagePath);
                    return imagePath;
                }
            }

            // If no image found in either place
            elizaLogger.log("No recent image found in Supabase or memory");
            return "";
        } catch (error) {
            elizaLogger.error("Error in imagePathProvider:", error);
            return "";
        }
    }
};
