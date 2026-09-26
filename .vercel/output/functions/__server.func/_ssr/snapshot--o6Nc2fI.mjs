import { n as TSS_SERVER_FUNCTION, t as createServerFn } from "./ssr.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/snapshot--o6Nc2fI.js
var createServerRpc = (serverFnMeta, splitImportFn) => {
	const url = "/_serverFn/" + serverFnMeta.id;
	return Object.assign(splitImportFn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var getMarketSnapshot_createServerFn_handler = createServerRpc({
	id: "935ab48d8718b307a4bbd5fa411dc60a4cc004a3d19d36a4a1964d5d5bdbed99",
	name: "getMarketSnapshot",
	filename: "src/lib/snapshot.ts"
}, (opts) => getMarketSnapshot.__executeServer(opts));
var getMarketSnapshot = createServerFn({ method: "GET" }).handler(getMarketSnapshot_createServerFn_handler, async () => {
	const { loadSnapshot } = await import("./market-data.server-DK4APTBW.mjs");
	return loadSnapshot();
});
//#endregion
export { getMarketSnapshot_createServerFn_handler };
