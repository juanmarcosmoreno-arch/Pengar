import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    /// Tapa de privacidad: con el bloqueo prendido, el selector de apps muestra el suricata y no los números
    private var cover: UIView?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PengarViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // Nativo para que llegue a tiempo: la captura del selector de apps se saca enseguida, antes de que la web se
    // entere. También tapa durante el cartel de Face ID (no molesta: debajo está la pantalla de bloqueo)
    func sceneWillResignActive(_ scene: UIScene) {
        guard PengarLockPlugin.coverEnabled, cover == nil, let window = window else { return }
        let view = UIView(frame: window.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Crema #F5F3EE, como la app
        view.backgroundColor = UIColor(red: 245 / 255, green: 243 / 255, blue: 238 / 255, alpha: 1)
        let image = UIImageView(image: UIImage(named: "Tapa"))
        image.contentMode = .scaleAspectFit
        image.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(image)
        NSLayoutConstraint.activate([
            image.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            image.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            image.heightAnchor.constraint(equalToConstant: 180),
            image.widthAnchor.constraint(equalTo: image.heightAnchor, multiplier: 457.0 / 640.0),
        ])
        window.addSubview(view)
        cover = view
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        guard let view = cover else { return }
        cover = nil
        // Un instante antes de sacarla, para que la web ya muestre la pantalla de bloqueo si hace falta
        UIView.animate(withDuration: 0.2, delay: 0.15, options: [.beginFromCurrentState]) {
            view.alpha = 0
        } completion: { _ in
            view.removeFromSuperview()
        }
    }
}
