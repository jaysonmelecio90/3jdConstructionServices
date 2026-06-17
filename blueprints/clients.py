from flask import Blueprint, render_template, redirect, url_for, flash, request
from flask_login import login_required

from extensions import db
from models import Client
from forms import ClientForm

bp = Blueprint("clients", __name__, url_prefix="/clients")


@bp.route("/")
@login_required
def index():
    q = request.args.get("q", "").strip()
    query = Client.query
    if q:
        like = f"%{q}%"
        query = query.filter(
            db.or_(Client.name.ilike(like), Client.email.ilike(like), Client.phone.ilike(like))
        )
    clients = query.order_by(Client.name.asc()).all()
    return render_template("clients/index.html", clients=clients, q=q)


@bp.route("/new", methods=["GET", "POST"])
@login_required
def new():
    form = ClientForm()
    if form.validate_on_submit():
        client = Client(
            name=form.name.data.strip(),
            phone=form.phone.data,
            email=form.email.data,
            address=form.address.data,
            notes=form.notes.data,
        )
        db.session.add(client)
        db.session.commit()
        flash("Client created.", "success")
        return redirect(url_for("clients.index"))
    return render_template("clients/form.html", form=form, mode="new")


@bp.route("/<int:client_id>/edit", methods=["GET", "POST"])
@login_required
def edit(client_id):
    client = Client.query.get_or_404(client_id)
    form = ClientForm(obj=client)
    if form.validate_on_submit():
        form.populate_obj(client)
        db.session.commit()
        flash("Client updated.", "success")
        return redirect(url_for("clients.index"))
    return render_template("clients/form.html", form=form, mode="edit", client=client)


@bp.route("/<int:client_id>/delete", methods=["POST"])
@login_required
def delete(client_id):
    client = Client.query.get_or_404(client_id)
    db.session.delete(client)
    db.session.commit()
    flash("Client deleted.", "info")
    return redirect(url_for("clients.index"))
