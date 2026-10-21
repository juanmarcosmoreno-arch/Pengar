import Capacitor
import UIKit

/// Controlador principal: registra los plugins propios de Pengar.
class PengarViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PengarOCRPlugin())
        bridge?.registerPluginInstance(PengarAIPlugin())
    }
}
