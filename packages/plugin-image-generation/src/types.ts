import { State } from "@elizaos/core";

declare module "@elizaos/core" {
    interface State {
        imageGeneration?: ImageGenerationState;
    }
}

export interface ImageGenerationState {
    lastGeneratedImage?: {
        path: string;
        timestamp: number;
        prompt?: string;
    };
    pendingPost?: boolean;
}
