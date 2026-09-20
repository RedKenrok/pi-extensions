declare module "@mixmark-io/domino" {
	interface Domino {
		createDocument(html?: string, force?: boolean): Document;
	}

	const domino: Domino;
	export default domino;
}
