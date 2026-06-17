from flask import Blueprint, render_template
from flask_login import login_required
from sqlalchemy import func

from extensions import db
from models import Proposal, Client, Architect, Company

bp = Blueprint("dashboard", __name__)


@bp.route("/")
@login_required
def index():
    stats = {
        "proposals": Proposal.query.count(),
        "clients": Client.query.count(),
        "architects": Architect.query.count(),
        "companies": Company.query.count(),
        "approved": Proposal.query.filter_by(status="Approved").count(),
        "submitted": Proposal.query.filter_by(status="Submitted").count(),
        "draft": Proposal.query.filter_by(status="Draft").count(),
        "paid": Proposal.query.filter_by(status="Paid").count(),
    }
    total_billed = db.session.query(func.coalesce(func.sum(Proposal.price_approved), 0)).scalar() or 0
    total_payed = db.session.query(func.coalesce(func.sum(Proposal.payed), 0)).scalar() or 0
    stats["total_billed"] = total_billed
    stats["total_payed"] = total_payed
    stats["total_outstanding"] = max(0, (total_billed or 0) - (total_payed or 0))

    recent = (
        Proposal.query.order_by(Proposal.created_at.desc()).limit(8).all()
    )
    return render_template("dashboard/index.html", stats=stats, recent=recent)
