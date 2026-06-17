from flask import Flask, redirect, url_for
from flask_login import current_user

from config import Config
from extensions import db, login_manager


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)
    login_manager.init_app(app)

    from blueprints.auth import bp as auth_bp
    from blueprints.dashboard import bp as dashboard_bp
    from blueprints.clients import bp as clients_bp
    from blueprints.architects import bp as architects_bp
    from blueprints.proposals import bp as proposals_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(clients_bp)
    app.register_blueprint(architects_bp)
    app.register_blueprint(proposals_bp)

    @app.route("/")
    def root():
        if current_user.is_authenticated:
            return redirect(url_for("dashboard.index"))
        return redirect(url_for("auth.login"))

    @app.template_filter("money")
    def money_filter(value):
        if value is None or value == "":
            return ""
        try:
            return f"₱{float(value):,.2f}"
        except (TypeError, ValueError):
            return str(value)

    @app.template_filter("nice_date")
    def nice_date(value):
        if not value:
            return ""
        try:
            return value.strftime("%b %d, %Y")
        except AttributeError:
            return str(value)

    with app.app_context():
        db.create_all()

    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
