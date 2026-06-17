from flask import Blueprint, render_template, redirect, url_for, flash, request
from flask_login import login_required

from extensions import db
from models import Architect, Company
from forms import ArchitectForm

bp = Blueprint("architects", __name__, url_prefix="/architects")


def _get_or_create_company(name, address=None):
    name = (name or "").strip()
    if not name:
        return None
    company = Company.query.filter(db.func.lower(Company.name) == name.lower()).first()
    if company is None:
        company = Company(name=name, address=address)
        db.session.add(company)
        db.session.flush()
    elif address and not company.address:
        company.address = address
    return company


@bp.route("/")
@login_required
def index():
    q = request.args.get("q", "").strip()
    query = Architect.query
    if q:
        like = f"%{q}%"
        query = query.filter(
            db.or_(Architect.name.ilike(like), Architect.email.ilike(like))
        )
    architects = query.order_by(Architect.name.asc()).all()
    return render_template("architects/index.html", architects=architects, q=q)


@bp.route("/new", methods=["GET", "POST"])
@login_required
def new():
    form = ArchitectForm()
    if form.validate_on_submit():
        company = _get_or_create_company(form.company_name.data, form.company_address.data)
        architect = Architect(
            name=form.name.data.strip(),
            title=form.title.data,
            phone=form.phone.data,
            email=form.email.data,
            notes=form.notes.data,
            company=company,
        )
        db.session.add(architect)
        db.session.commit()
        flash("Architect saved.", "success")
        return redirect(url_for("architects.index"))
    return render_template("architects/form.html", form=form, mode="new")


@bp.route("/<int:architect_id>/edit", methods=["GET", "POST"])
@login_required
def edit(architect_id):
    architect = Architect.query.get_or_404(architect_id)
    form = ArchitectForm(obj=architect)
    if request.method == "GET" and architect.company:
        form.company_name.data = architect.company.name
        form.company_address.data = architect.company.address

    if form.validate_on_submit():
        architect.name = form.name.data.strip()
        architect.title = form.title.data
        architect.phone = form.phone.data
        architect.email = form.email.data
        architect.notes = form.notes.data
        architect.company = _get_or_create_company(
            form.company_name.data, form.company_address.data
        )
        db.session.commit()
        flash("Architect updated.", "success")
        return redirect(url_for("architects.index"))
    return render_template("architects/form.html", form=form, mode="edit", architect=architect)


@bp.route("/<int:architect_id>/delete", methods=["POST"])
@login_required
def delete(architect_id):
    architect = Architect.query.get_or_404(architect_id)
    db.session.delete(architect)
    db.session.commit()
    flash("Architect deleted.", "info")
    return redirect(url_for("architects.index"))
