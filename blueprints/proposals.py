from datetime import date
from flask import Blueprint, render_template, redirect, url_for, flash, request
from flask_login import login_required, current_user
from sqlalchemy import desc

from extensions import db
from models import Proposal, Client, Architect
from forms import ProposalForm
from config import Config

bp = Blueprint("proposals", __name__, url_prefix="/proposals")


DEFAULT_SCOPE = """1.) Structural Analysis and Design Computations of all structural members
   a. Create Framing Plans, Foundation Plans, etc.
   b. Estimate/compute all dead, live, wind and seismic loads present in every structural member
   c. Generate the structure model
   d. Perform Structural Analysis (Compute design axial, shear, moment and deflection)
   e. Perform Structural Design (Proportion member dimensions, number of reinforcements, etc.)
   f. Check and Re-analyze the Structural Design Output
2.) CAD drawings of all structural plans, schedules and details (20"x30" sheets, ready for printing).
3.) Perform Structural Revisions if there are any minor changes
4.) Sign and seal of all structural drawings and other pertinent documents required by the Office of the Building Official"""


DEFAULT_DELIVERABLES = """1. One (1) copy of the Structural Analysis and Design Computations Output (for OBO).
2. CAD files of all the structural drawings."""

DEFAULT_SCHEDULE = "Fifteen (15) working days upon receipt of confirmation of the proposal."

DEFAULT_PAYMENT = """The total service fee for the scope of work as described above shall be a lump sum amount, billed in two installments:
- 50% upon confirmation of the proposal (downpayment)
- 50% upon delivery of the final output"""


def _populate_choices(form):
    form.client_id.choices = [(0, "— none —")] + [
        (c.id, c.name) for c in Client.query.order_by(Client.name).all()
    ]
    form.architect_id.choices = [(0, "— none —")] + [
        (a.id, f"{a.name}" + (f" — {a.company.name}" if a.company else ""))
         for a in Architect.query.order_by(Architect.name).all()
    ]


def _next_project_number():
    last = (
        db.session.query(Proposal.project_number)
        .filter(Proposal.project_number.isnot(None))
        .all()
    )
    nums = []
    for (val,) in last:
        if not val:
            continue
        digits = "".join(ch for ch in str(val) if ch.isdigit())
        if digits:
            nums.append(int(digits))
    base = max(nums) if nums else Config.NEXT_PROJECT_NUMBER_START
    return f"P{base + 1}"


@bp.route("/")
@login_required
def index():
    q = request.args.get("q", "").strip()
    status = request.args.get("status", "").strip()
    query = Proposal.query
    if q:
        like = f"%{q}%"
        query = query.filter(
            db.or_(
                Proposal.project_title.ilike(like),
                Proposal.project_number.ilike(like),
                Proposal.location.ilike(like),
            )
        )
    if status:
        query = query.filter_by(status=status)
    proposals = query.order_by(desc(Proposal.date_received), desc(Proposal.id)).all()
    return render_template("proposals/index.html", proposals=proposals, q=q, status=status)


@bp.route("/<int:proposal_id>")
@login_required
def view(proposal_id):
    proposal = Proposal.query.get_or_404(proposal_id)
    return render_template("proposals/view.html", proposal=proposal, company=Config)


@bp.route("/new", methods=["GET", "POST"])
@login_required
def new():
    form = ProposalForm()
    _populate_choices(form)

    if request.method == "GET":
        form.project_number.data = _next_project_number()
        form.date_received.data = date.today()
        form.date_proposed.data = date.today()
        form.scope_of_work.data = DEFAULT_SCOPE
        form.deliverables.data = DEFAULT_DELIVERABLES
        form.schedule_duration.data = DEFAULT_SCHEDULE
        form.payment_terms.data = DEFAULT_PAYMENT
        form.category.data = "Structural Design"

    if form.validate_on_submit():
        proposal = Proposal(created_by=current_user)
        _assign_from_form(proposal, form)
        db.session.add(proposal)
        db.session.commit()
        flash(f"Proposal {proposal.project_number or proposal.id} created.", "success")
        return redirect(url_for("proposals.view", proposal_id=proposal.id))

    return render_template("proposals/form.html", form=form, mode="new")


@bp.route("/<int:proposal_id>/edit", methods=["GET", "POST"])
@login_required
def edit(proposal_id):
    proposal = Proposal.query.get_or_404(proposal_id)
    form = ProposalForm(obj=proposal)
    _populate_choices(form)

    if request.method == "GET":
        form.client_id.data = proposal.client_id or 0
        form.architect_id.data = proposal.architect_id or 0

    if form.validate_on_submit():
        _assign_from_form(proposal, form)
        db.session.commit()
        flash("Proposal updated.", "success")
        return redirect(url_for("proposals.view", proposal_id=proposal.id))

    return render_template("proposals/form.html", form=form, mode="edit", proposal=proposal)


@bp.route("/<int:proposal_id>/delete", methods=["POST"])
@login_required
def delete(proposal_id):
    proposal = Proposal.query.get_or_404(proposal_id)
    db.session.delete(proposal)
    db.session.commit()
    flash("Proposal deleted.", "info")
    return redirect(url_for("proposals.index"))


def _assign_from_form(proposal, form):
    proposal.project_number = (form.project_number.data or "").strip() or None
    proposal.date_received = form.date_received.data
    proposal.date_proposed = form.date_proposed.data
    proposal.project_title = form.project_title.data.strip()
    proposal.category = form.category.data
    proposal.location = form.location.data
    proposal.client_id = form.client_id.data or None
    proposal.architect_id = form.architect_id.data or None
    proposal.lot_area_sqm = form.lot_area_sqm.data
    proposal.rate_per_sqm = form.rate_per_sqm.data
    proposal.sheet_count = form.sheet_count.data
    proposal.rate_per_sheet = form.rate_per_sheet.data
    proposal.price = form.price.data or _compute_price(form)
    proposal.price_approved = form.price_approved.data
    proposal.payed = form.payed.data or 0
    proposal.status = form.status.data
    proposal.payment_method = form.payment_method.data
    proposal.date_approved = form.date_approved.data
    proposal.scope_of_work = form.scope_of_work.data
    proposal.deliverables = form.deliverables.data
    proposal.schedule_duration = form.schedule_duration.data
    proposal.payment_terms = form.payment_terms.data
    proposal.remarks = form.remarks.data


def _compute_price(form):
    total = 0.0
    if form.lot_area_sqm.data and form.rate_per_sqm.data:
        total += form.lot_area_sqm.data * form.rate_per_sqm.data
    if form.sheet_count.data and form.rate_per_sheet.data:
        total += form.sheet_count.data * form.rate_per_sheet.data
    return total or None
