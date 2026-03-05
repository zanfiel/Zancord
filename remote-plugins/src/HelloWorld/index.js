// Sample remote plugin: HelloWorld
// This demonstrates the bundle format for Zancord remote plugins.
//
// Remote plugin bundles must return a PluginDef-compatible object.
// They CANNOT use patches (webpack module replacement).
// They CAN use: start/stop, commands, flux events, context menus,
// toolbox actions, and all register/unregister APIs available at runtime.
//
// The bundle is evaluated via `new Function()` so it does not have
// direct access to imports. Use `Vencord.Api`, `Vencord.Webpack`, etc.
// from the global `Vencord` object which is available at runtime.

return {
    name: "HelloWorld",
    description: "A sample remote plugin that shows a notification on start.",
    authors: [{ name: "Zan", id: 983426436306182144n }],
    
    start() {
        // Access Vencord APIs via the global object
        if (typeof Vencord !== "undefined" && Vencord.Api?.Notifications) {
            Vencord.Api.Notifications.showNotification({
                title: "Hello from Remote Plugin!",
                body: "The HelloWorld remote plugin has started successfully.",
                color: "#ff2d95",
            });
        }
        console.log("[HelloWorld Remote Plugin] Started!");
    },

    stop() {
        console.log("[HelloWorld Remote Plugin] Stopped!");
    },

    toolboxActions: {
        "Say Hello": () => {
            if (typeof Vencord !== "undefined" && Vencord.Api?.Notifications) {
                Vencord.Api.Notifications.showNotification({
                    title: "Hello!",
                    body: "Greetings from the HelloWorld remote plugin!",
                    color: "#00f0ff",
                });
            }
        }
    }
};
