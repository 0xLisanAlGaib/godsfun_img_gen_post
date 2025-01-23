import { Plugin } from "@elizaos/core";
import { postAction } from "./actions/post";
import { postImageAction } from "./actions/postImage";
import { shouldPostImageEvaluator } from "./evaluators/shouldPostImage";
import { imagePathProvider } from "./providers/imagePathProvider";

export const twitterPlugin: Plugin = {
    name: "twitter",
    description: "Twitter integration plugin for posting tweets",
    actions: [postAction, postImageAction],
    evaluators: [shouldPostImageEvaluator],
    providers: [imagePathProvider],
};

export default twitterPlugin;
