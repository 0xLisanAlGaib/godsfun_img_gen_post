import { Plugin } from "@elizaos/core";
import { postAction } from "./actions/post";
import { postImageAction } from "./actions/postImage";

export const twitterPlugin: Plugin = {
    name: "twitter",
    description: "Twitter integration plugin for posting tweets",
    actions: [postAction, postImageAction],
    evaluators: [],
    providers: [],
};

export default twitterPlugin;
