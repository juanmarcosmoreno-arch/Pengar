import Capacitor
import Foundation
import LocalAuthentication

/// Bloqueo de Pengar con Face ID (o Touch ID / Optic ID). Usa `.deviceOwnerAuthentication`: si la cara no se
/// reconoce, el iPhone ofrece su código. También guarda si la tapa del selector de apps va (la pone el SceneDelegate).
@objc(PengarLockPlugin)
public class PengarLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PengarLockPlugin"
    public let jsName = "PengarLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPrivacyCover", returnType: CAPPluginReturnPromise),
    ]

    private static let coverKey = "PengarPrivacyCover"

    /// ¿Tapar la app al salir? Queda guardado: al abrir, antes de que cargue la web, ya vale lo último que dijo
    static var coverEnabled: Bool {
        UserDefaults.standard.bool(forKey: coverKey)
    }

    // MARK: - Disponibilidad

    /// `biometry`: faceID | touchID | opticID | none (none si no está configurado: queda el código).
    /// `available`: hay biometría o al menos código en el iPhone
    @objc func availability(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let biometric = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        // Bloqueado por muchos intentos sigue configurado (pide el código hasta que se desbloquee el iPhone)
        let lockedOut = (error as? LAError)?.code == .biometryLockout
        let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        call.resolve([
            "biometry": (biometric || lockedOut) ? PengarLockPlugin.name(of: context.biometryType) : "none",
            "available": available,
        ])
    }

    private static func name(of type: LABiometryType) -> String {
        if #available(iOS 17.0, *), type == .opticID { return "opticID" }
        switch type {
        case .faceID: return "faceID"
        case .touchID: return "touchID"
        default: return "none"
        }
    }

    // MARK: - Desbloquear

    /// Resuelve si pasa. Rechaza con el código: cancel | fallback | lockout | notAvailable | failed
    @objc func authenticate(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Para abrir Pengar"
        let context = LAContext()
        context.localizedCancelTitle = "Cancelar"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            call.reject("Este iPhone no tiene Face ID ni código", PengarLockPlugin.code(for: error), error)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
            if ok {
                call.resolve()
            } else {
                call.reject(error?.localizedDescription ?? "No se pudo comprobar", PengarLockPlugin.code(for: error), error)
            }
        }
    }

    private static func code(for error: Error?) -> String {
        guard let error = error as? LAError else { return "failed" }
        switch error.code {
        // notInteractive: se pidió con la app en segundo plano; al volver se pide de nuevo
        case .userCancel, .systemCancel, .appCancel, .notInteractive: return "cancel"
        case .userFallback: return "fallback"
        case .biometryLockout: return "lockout"
        case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled: return "notAvailable"
        default: return "failed"
        }
    }

    // MARK: - Tapa del selector de apps

    @objc func setPrivacyCover(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        UserDefaults.standard.set(enabled, forKey: PengarLockPlugin.coverKey)
        call.resolve()
    }
}
