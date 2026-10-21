import Capacitor
import UIKit
import WebKit

/// Controlador principal: registra los plugins propios de Pengar y respeta el tamaño de texto del sistema.
class PengarViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PengarOCRPlugin())
        bridge?.registerPluginInstance(PengarAIPlugin())
        // «Texto más grande» de iOS: WKWebView no lo aplica solo. Se agranda el texto de la página (como hace
        // @capacitor/text-zoom) al cargarla y cada vez que cambia el ajuste
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: textSizeScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        NotificationCenter.default.addObserver(
            self, selector: #selector(textSizeChanged), name: UIContentSizeCategory.didChangeNotification, object: nil)
    }

    /// Porcentaje del texto según el tamaño elegido en iOS (100 % el de fábrica). Con tope: pasado 150 % no entra en pantalla
    private func textSizePercent() -> Int {
        let scaled = UIFontMetrics(forTextStyle: .body).scaledValue(for: 100)
        return Int(min(150, max(85, scaled)).rounded())
    }

    private func textSizeScript() -> String {
        "document.documentElement.style.webkitTextSizeAdjust = '\(textSizePercent())%';"
    }

    @objc private func textSizeChanged() {
        webView?.evaluateJavaScript(textSizeScript())
    }
}
